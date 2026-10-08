/**
 * Plan a relay launch on Orca's pinned Node with the orcad slot's prebuilt addons, instead
 * of the host's Node plus a host-side npm install (design D5, D6 rung A, D8.1).
 *
 * Opt-in per host (`SshTarget.remoteRuntime`), and on by default where managed orcad can't run.
 * Anything this module cannot establish on the client, and every classified refusal from the
 * host, falls back to the legacy host-Node path with a logged reason.
 */
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  isWindowsServerTarget,
  pinnedNodeRuntimeAsset,
  type CompatServerTarget,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_PTY_JS_ARTIFACTS,
  ORCAD_PARCEL_WATCHER_ENTRY,
  ORCAD_PARCEL_WATCHER_NATIVE,
  ORCAD_WINDOWS_PROCESS_TREE_FILENAME,
  orcadNodePtyNativeArtifacts,
  orcadNodeRuntimeExecutable
} from '../../shared/orcad-artifacts'
import {
  DEFAULT_SSH_REMOTE_RUNTIME,
  SSH_REMOTE_RUNTIMES,
  type SshRemoteRuntime,
  type SshTarget
} from '../../shared/ssh-types'
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import {
  resolveOrcadDeploymentTargetFacts,
  UnidentifiedHostLibcError,
  type GlibcVersion,
  type OrcadDeploymentTargetFacts
} from './orcad-deployment-target'
import { remoteNodeRuntimeDir } from './orcad-remote-node-runtime'
import { fileSha256, materializeNodeRuntimeArchive } from './pinned-runtime-materializer'
import type { SshConnection } from './ssh-connection'
import { PINNED_RUNTIME_REFUSALS, type PinnedRuntimeRefusal } from './ssh-relay-runtime-self-test'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

/** Content-keyed like ripgrep's refs, so runtime GC can find holders without a new concept (D5). */
export const RELAY_RUNTIME_REF_PREFIX = '.runtime-ref-node-'
/** Official linux builds of the pinned Node need glibc 2.28; older hosts are rung B/C territory. */
export const PINNED_NODE_GLIBC_FLOOR: GlibcVersion = { major: 2, minor: 28 }
/** Developer override when no per-host setting is saved. */
export const SSH_REMOTE_RUNTIME_ENV = 'ORCA_SSH_REMOTE_RUNTIME'

export function resolveSshRemoteRuntime(
  target: Pick<SshTarget, 'remoteRuntime' | 'managedServerUnavailable'> | undefined,
  env: NodeJS.ProcessEnv = process.env
): SshRemoteRuntime {
  if (target?.remoteRuntime) {
    return target.remoteRuntime
  }
  const fromEnv = SSH_REMOTE_RUNTIMES.find((runtime) => runtime === env[SSH_REMOTE_RUNTIME_ENV])
  // Why: where managed orcad can't run the relay is the host's server; the ladder still ends at legacy.
  return fromEnv ?? (target?.managedServerUnavailable ? 'pinned-node' : DEFAULT_SSH_REMOTE_RUNTIME)
}

/** Why `recorded`: this connect's host-server decision may have just recorded orcad unavailable. */
export function resolveConnectRemoteRuntime(
  target: SshTarget | undefined,
  recorded: SshTarget | undefined
): SshRemoteRuntime {
  const managedServerUnavailable =
    recorded?.managedServerUnavailable ?? target?.managedServerUnavailable
  return resolveSshRemoteRuntime(target && { ...target, managedServerUnavailable })
}

export function isGlibcBelow(version: GlibcVersion, floor: GlibcVersion): boolean {
  return (
    version.major < floor.major || (version.major === floor.major && version.minor < floor.minor)
  )
}

/**
 * Folds the runtime and addon bytes into the relay's content version, so a pinned build and a
 * host-Node build of the same relay never share a directory or a socket (D8.1).
 */
export function pinnedNodeRelayFullVersion(
  baseVersion: string,
  executableSha256: string,
  addonDigest: string
): string {
  const match = /^(v?[0-9]+\.[0-9]+\.[0-9]+)(?:\+[0-9a-f]+)?$/.exec(baseVersion)
  if (!match) {
    throw new Error(`Relay version is not <semver>[+<hex>]: ${baseVersion}`)
  }
  const digest = createHash('sha256')
    .update(`${baseVersion}\0node-runtime\0${executableSha256}\0${addonDigest}`)
    .digest('hex')
  return `${match[1]}+${digest.slice(0, 12)}`
}

export function pinnedRelayAddonFiles(target: NodeRuntimeTarget): string[] {
  return [
    ...ORCAD_NODE_PTY_JS_ARTIFACTS,
    ...orcadNodePtyNativeArtifacts(target),
    ORCAD_PARCEL_WATCHER_ENTRY,
    ORCAD_PARCEL_WATCHER_NATIVE,
    // The slot's patched copy, so the process table never falls back to a PowerShell scan.
    ...(isWindowsServerTarget(target) ? [ORCAD_WINDOWS_PROCESS_TREE_FILENAME] : [])
  ]
}

export type PinnedRelayAddons = {
  /** Upload this directory's contents into the relay version dir. */
  dir: string
  digest: string
  dispose: () => Promise<void>
}

/** Copies this target's node-pty and watcher out of a verified orcad slot, beside a runtime ref. */
export async function stagePinnedRelayAddons(
  orcadDir: string,
  target: NodeRuntimeTarget,
  stagingParent: string = tmpdir(),
  /** Rung C runs on the host's Node, so its dir must not hold a pinned runtime against GC. */
  options: { runtimeRef: boolean } = { runtimeRef: true }
): Promise<PinnedRelayAddons> {
  const dir = await mkdtemp(join(stagingParent, 'orca-relay-addons-'))
  try {
    const hash = createHash('sha256')
    for (const file of pinnedRelayAddonFiles(target).sort()) {
      const source = join(orcadDir, ...file.split('/'))
      const sha = await fileSha256(source)
      if (!sha) {
        throw new Error(`The orcad slot for ${target} has no ${file}`)
      }
      const destination = join(dir, ...file.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
      if (file.endsWith('/spawn-helper')) {
        await chmod(destination, 0o755)
      }
      hash.update(`${file}\0${sha}\n`)
    }
    if (options.runtimeRef) {
      const executableSha256 = pinnedNodeRuntimeAsset(target).executableSha256
      await writeFile(
        join(dir, `${RELAY_RUNTIME_REF_PREFIX}${executableSha256}`),
        `${executableSha256}\n`
      )
    }
    return {
      dir,
      digest: hash.digest('hex'),
      dispose: () => rm(dir, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/** `~/.orca-remote/runtimes/node-<sha>/bin/node` (`…\\node.exe` on Windows), shared with orcad slots. */
export function pinnedRelayNodePath(
  host: RemoteHostPlatform,
  remoteRelayDir: string,
  target: NodeRuntimeTarget
): string {
  return joinRemotePath(
    host,
    remoteNodeRuntimeDir(host, remoteRelayDir, target),
    ...orcadNodeRuntimeExecutable(target).split('/')
  )
}

export type PinnedRelayPlan = {
  kind: 'pinned-node'
  /** A compat target (rung B) when the plan runs a compat runtime on an older-glibc host. */
  target: NodeRuntimeTarget
  glibc: GlibcVersion | null
  fullVersion: string
  addons: PinnedRelayAddons
  runtimeArchive: () => Promise<string>
}

export type RelayRuntimeFallbackReason =
  | PinnedRuntimeRefusal
  /** Rung C only: the host-Node addon relay is POSIX-only. */
  | 'windows_host_unsupported'
  | 'target_unresolved'
  | 'artifacts_unavailable'
  /** No runtime exists for this rung and host (rung B before a compat build ships). */
  | 'runtime_unavailable'
  /** Rung C found no host Node >= 18 with the addons' N-API level. */
  | 'host_node_missing'

export type HostNodeRelayPlan = {
  kind: 'host-node'
  fallbackReason?: RelayRuntimeFallbackReason
  /** Replayed from a cache rather than proved on this connect. */
  remembered?: boolean
}

/** The pinned path cannot run on this host or client; the deploy retries on the host's Node. */
export class PinnedRelayFallbackError extends Error {
  constructor(
    readonly reason: RelayRuntimeFallbackReason,
    readonly detail: string,
    /** A remembered refusal skips its rung but never proves anything about the next one. */
    readonly remembered = false
  ) {
    super(`Orca's pinned Node relay is unavailable (${reason}): ${detail}`)
    this.name = 'PinnedRelayFallbackError'
  }
}

export function isPinnedRuntimeRefusal(reason: string): reason is PinnedRuntimeRefusal {
  return PINNED_RUNTIME_REFUSALS.some((refusal) => refusal === reason)
}

// Why also in memory: the persisted decision is written only once the ladder settles.
const refusals = new Map<string, PinnedRuntimeRefusal>()

function refusalKey(targetId: string, target: NodeRuntimeTarget): string {
  return `${targetId}\0${pinnedNodeRuntimeAsset(target).executableSha256}`
}

export function recordPinnedRuntimeRefusal(
  targetId: string,
  target: NodeRuntimeTarget,
  refusal: PinnedRuntimeRefusal
): void {
  refusals.set(refusalKey(targetId, target), refusal)
}

/** Forgets a refusal a later rung has disproved, so the next connect retries rung A. */
export function forgetPinnedRuntimeRefusal(targetId: string, target: NodeRuntimeTarget): void {
  refusals.delete(refusalKey(targetId, target))
}

export function resetPinnedRuntimeRefusalsForTests(): void {
  refusals.clear()
}

export function logPinnedRelayFallback(
  reason: RelayRuntimeFallbackReason,
  detail: string
): HostNodeRelayPlan {
  console.warn(`[ssh-relay] Pinned Node relay unavailable (${reason}): ${detail}; using host Node`)
  return { kind: 'host-node', fallbackReason: reason }
}

/**
 * The host's server target, or a fallback when the libc probe answered with nothing known.
 * Why only an answered probe falls back: a lost channel says nothing about the host, and
 * descending would launch a second daemon beside a running pinned one, stranding its sessions.
 */
export async function resolvePinnedRelayTargetFacts(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
}): Promise<OrcadDeploymentTargetFacts | HostNodeRelayPlan> {
  try {
    return await resolveOrcadDeploymentTargetFacts(options)
  } catch (error) {
    if (!(error instanceof UnidentifiedHostLibcError)) {
      throw error
    }
    return logPinnedRelayFallback('target_unresolved', error.message)
  }
}

export async function planPinnedNodeRelay(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  baseVersion: string
  targetId: string
  signal?: AbortSignal
  /** Already resolved by the ladder; resolved here when absent. */
  facts?: OrcadDeploymentTargetFacts
  /** A refusal persisted for this host under a still-matching key (D6). */
  persistedRefusal?: (facts: OrcadDeploymentTargetFacts) => PinnedRuntimeRefusal | null
  /** Rung B: run this compat runtime and its slot instead of the host target's own. */
  compat?: { target: CompatServerTarget; glibcFloor: GlibcVersion | null }
  materializeOrcad?: (target: NodeRuntimeTarget, signal?: AbortSignal) => Promise<string>
  runtimeCacheRoot?: () => string
}): Promise<PinnedRelayPlan | HostNodeRelayPlan> {
  const { host, signal } = options
  const facts =
    options.facts ?? (await resolvePinnedRelayTargetFacts({ conn: options.conn, host, signal }))
  if ('kind' in facts) {
    return facts
  }
  const { glibc } = facts
  const { compat } = options
  const target: NodeRuntimeTarget = compat?.target ?? facts.target
  const cached = refusals.get(refusalKey(options.targetId, target))
  if (cached) {
    return { ...logPinnedRelayFallback(cached, 'refused earlier this session'), remembered: true }
  }
  // Why rung A only: the persisted decision is keyed by the default runtime's hash.
  const persisted = compat ? null : options.persistedRefusal?.(facts)
  if (persisted) {
    return {
      ...logPinnedRelayFallback(persisted, 'refused on an earlier connect'),
      remembered: true
    }
  }
  const floor = compat ? compat.glibcFloor : PINNED_NODE_GLIBC_FLOOR
  if (glibc && floor && isGlibcBelow(glibc, floor)) {
    recordPinnedRuntimeRefusal(options.targetId, target, 'libc_floor')
    return logPinnedRelayFallback(
      'libc_floor',
      `host glibc ${glibc.major}.${glibc.minor} is below ${floor.major}.${floor.minor}`
    )
  }
  let addons: PinnedRelayAddons
  try {
    const materialize =
      options.materializeOrcad ?? ((t, s) => materializeOrcadArtifact(t, { signal: s }))
    addons = await stagePinnedRelayAddons(await materialize(target, signal), target)
  } catch (error) {
    signal?.throwIfAborted()
    return logPinnedRelayFallback(
      'artifacts_unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
  const cacheRoot =
    options.runtimeCacheRoot ??
    ((): string => join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'))
  let fullVersion: string
  try {
    fullVersion = pinnedNodeRelayFullVersion(
      options.baseVersion,
      pinnedNodeRuntimeAsset(target).executableSha256,
      addons.digest
    )
  } catch (error) {
    await addons.dispose()
    throw error
  }
  return {
    kind: 'pinned-node',
    target,
    glibc,
    fullVersion,
    addons,
    runtimeArchive: () =>
      materializeNodeRuntimeArchive(target, cacheRoot(), { signal }).catch((error: unknown) => {
        signal?.throwIfAborted()
        throw new PinnedRelayFallbackError(
          'artifacts_unavailable',
          error instanceof Error ? error.message : String(error)
        )
      })
  }
}
