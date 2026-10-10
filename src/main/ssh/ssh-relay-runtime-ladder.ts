/**
 * The design D6 fallback ladder for the relay runtime, as data plus a pure step function:
 *
 *   A       Orca's pinned Node + slot prebuilds
 *   B       a compat pinned Node + compat addons (chosen only when a compat runtime exists)
 *   C       the host's Node >= 18 + Orca's N-API prebuilds, no npm
 *   legacy  the host's Node + npm install, unsupported; the only rung when the user opts in
 *   D       nothing runs: plain SSH terminals and SFTP, recording the classified reason
 *
 * The ladder steps down on a classified refusal (a `PinnedRelayFallbackError`), including an
 * answered host failure the deploy wraps as `install_failed`; an unverifiable probe or self-test
 * throws and the next connect retries the same rung.
 */
import {
  COMPAT_SERVER_TARGET_BASES,
  isCompatServerTarget,
  pinnedNodeRuntimeAsset,
  type CompatServerTarget,
  type NodeRuntimeTarget,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import type { SshRemoteRuntime, SshRemoteRuntimeRung } from '../../shared/ssh-types'
import type { GlibcVersion } from './orcad-deployment-target'
import type { RemoteOperatingSystem } from './ssh-remote-platform'
import {
  isGlibcBelow,
  PINNED_NODE_GLIBC_FLOOR,
  type RelayRuntimeFallbackReason
} from './ssh-relay-pinned-node'

export type RelayRuntimeStep = SshRemoteRuntimeRung

export type CompatRelayRuntime = {
  id: string
  /** The pinned compat runtime and orcad slot it runs (NODE_RUNTIME_COMPAT_ASSETS). */
  runtimeTarget: CompatServerTarget
  /** The host target this runtime serves, e.g. linux-x64-glibc for a glibc 2.17 build. */
  hostTarget: ServerTarget
  /** Null for a musl or darwin target, which has no glibc to compare. */
  glibcFloor: GlibcVersion | null
}

/** Rung B is chosen from this list alone. */
export const COMPAT_RELAY_RUNTIMES: readonly CompatRelayRuntime[] = [
  {
    id: 'glibc217',
    runtimeTarget: 'linux-x64-glibc217',
    hostTarget: COMPAT_SERVER_TARGET_BASES['linux-x64-glibc217'],
    glibcFloor: { major: 2, minor: 17 }
  }
]

export function relayRuntimeLadder(runtime: SshRemoteRuntime): readonly RelayRuntimeStep[] {
  // Why legacy before D: the unsupported host-npm fallback keeps the never-worse invariant.
  return runtime === 'pinned-node' ? ['A', 'B', 'C', 'legacy', 'D'] : ['legacy']
}

export function compatRelayRuntimeFor(
  facts: { target: ServerTarget; glibc: GlibcVersion | null },
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): CompatRelayRuntime | null {
  return (
    catalog.find(
      (runtime) =>
        runtime.hostTarget === facts.target &&
        (runtime.glibcFloor === null ||
          (facts.glibc !== null && !isGlibcBelow(facts.glibc, runtime.glibcFloor)))
    ) ?? null
  )
}

/**
 * Rung B runs only where A cannot: glibc below A's floor, or A refused for a missing or too-old
 * library, which the compat build's static libstdc++ and older glibc floor can answer.
 */
export function rungBCompatRuntimeFor(
  facts: { target: ServerTarget; glibc: GlibcVersion | null },
  rungARefusal: RelayRuntimeFallbackReason | null,
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): CompatRelayRuntime | null {
  const belowPinnedFloor =
    facts.glibc !== null && isGlibcBelow(facts.glibc, PINNED_NODE_GLIBC_FLOOR)
  if (!belowPinnedFloor && rungARefusal !== 'libc_floor' && rungARefusal !== 'missing_lib') {
    return null
  }
  return compatRelayRuntimeFor(facts, catalog)
}

/**
 * The pinned runtime Orca can run on a host by glibc alone: the default one, a compat one below
 * its floor, or null when neither can. Companions (the vault reader) use it to skip an upload
 * whose self-test could only fail.
 */
export function pinnedRuntimeTargetForHost(
  facts: { target: ServerTarget; glibc: GlibcVersion | null },
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): NodeRuntimeTarget | null {
  if (facts.glibc === null || !isGlibcBelow(facts.glibc, PINNED_NODE_GLIBC_FLOOR)) {
    return facts.target
  }
  return compatRelayRuntimeFor(facts, catalog)?.runtimeTarget ?? null
}

/**
 * executableSha256 of every runtime a relay on `target` keeps pinned in the host store: the
 * default runtime and its compat ones, so a rung A connect never collects the rung B runtime.
 */
export function relayRuntimeStorePins(
  target: NodeRuntimeTarget,
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): string[] {
  const hostTarget = isCompatServerTarget(target) ? COMPAT_SERVER_TARGET_BASES[target] : target
  const targets = [
    hostTarget,
    ...catalog
      .filter((runtime) => runtime.hostTarget === hostTarget)
      .map((runtime) => runtime.runtimeTarget)
  ]
  return [...new Set(targets.map((pin) => pinnedNodeRuntimeAsset(pin).executableSha256))]
}

/**
 * The invariant: no host does worse than the pre-ladder default. A, B and C are tried first
 * (no host compile where Orca's runtime works); any refusal past them falls back to exactly
 * that default, the host-Node relay (`legacy`, marked unsupported). D is reached only when that
 * fallback itself answered with a failure, so D is a superset of the default's outcome. Windows
 * reaches legacy because B and C refuse there before any host I/O.
 */
export function relayRuntimeStepAfterRefusal(
  ladder: readonly RelayRuntimeStep[],
  current: RelayRuntimeStep,
  reason: RelayRuntimeFallbackReason,
  remembered: boolean
): RelayRuntimeStep {
  // Why noexec skips B and C: they load addons from the same tree; only the fallback can disprove it.
  // A remembered noexec only skips its own rung: the mount may have changed since it was proved.
  if (reason === 'noexec' && !remembered && current !== 'legacy') {
    return 'legacy'
  }
  return ladder[ladder.indexOf(current) + 1] ?? 'D'
}

/** The machine-readable part of a rung D failure; the message is what the user reads. */
export const REMOTE_RUNTIME_UNAVAILABLE_REASONS = ['home_noexec', 'no_runtime'] as const
export type RemoteRuntimeUnavailableReason = (typeof REMOTE_RUNTIME_UNAVAILABLE_REASONS)[number]

const REMOTE_RUNTIME_UNAVAILABLE_MESSAGES: Record<RemoteRuntimeUnavailableReason, string> = {
  home_noexec:
    "Orca can't run its remote runtime on this host: the home directory is mounted noexec, so " +
    'nothing under ~/.orca-remote may execute. Remote terminals and file browsing are ' +
    'unavailable until an administrator allows exec there.',
  no_runtime:
    "Orca can't run its remote runtime on this host: its bundled Node.js was refused and no " +
    'Node.js 18 or newer with npm was found on the host. Install Node.js 18+ and npm on the ' +
    'host, then reconnect.'
}

// Why its own wording: a host Node would load addons from the same noexec tree, so installing one cannot help.
const REMEMBERED_NOEXEC_MESSAGE =
  "Orca can't run its remote runtime on this host: an earlier connect found the home directory " +
  'mounted noexec, so nothing under ~/.orca-remote may execute. Remote terminals and file ' +
  'browsing are unavailable until exec is allowed there; Orca re-checks on the next connect.'

const WINDOWS_NO_HOST_NODE_MESSAGE =
  "Orca can't run its remote runtime on this Windows host: its bundled Node.js could not run, " +
  'and no Node.js 18 or newer with npm was found on the host to run on instead. Allow ' +
  "Orca's Node.js through security software or application control, or install Node.js 18+ " +
  'on the host, then reconnect.'

// Why its own wording: the bundled Node never reached the host, so nothing about the host refused it.
const CLIENT_ARTIFACTS_NO_HOST_NODE_MESSAGE =
  "Orca can't run its remote runtime on this host: this copy of Orca could not prepare its bundled " +
  'Node.js, and no Node.js 18 or newer was found on the host to run on instead. Install Node.js ' +
  '18+ and npm on the host, or reconnect once Orca can fetch its runtime.'

// Why its own wording: the unsupported host-Node fallback ran and the host answered it with a failure.
const HOST_NODE_FALLBACK_FAILED_MESSAGE =
  "Orca can't run its remote runtime on this host: its bundled Node.js was refused, and the " +
  "host's own Node.js relay, an unsupported fallback, also failed to install. Check the host's " +
  'disk space and its Node.js and npm setup, then reconnect.'

export type RemoteRuntimeUnavailableState = {
  firstRefusal: RelayRuntimeFallbackReason | null
  /** D is reached only from the host-Node fallback, so 'host_node_missing' or 'install_failed'. */
  hostNodeRefusal: RelayRuntimeFallbackReason | null
  /** A noexec seen anywhere in the pass rules out advising a host Node. */
  noexec: 'remembered' | 'proved' | null
  hostOs: RemoteOperatingSystem | null
}

export function remoteRuntimeUnavailable(state: RemoteRuntimeUnavailableState): {
  reason: RemoteRuntimeUnavailableReason
  message: string
} {
  const { noexec, hostOs } = state
  // Why not on Windows: its 'noexec' is an application-control block, not a mount the user can fix.
  const reason = hostOs !== 'win32' && noexec !== null ? 'home_noexec' : 'no_runtime'
  return { reason, message: unavailableMessage(reason, state) }
}

function unavailableMessage(
  reason: RemoteRuntimeUnavailableReason,
  { firstRefusal, hostNodeRefusal, noexec, hostOs }: RemoteRuntimeUnavailableState
): string {
  if (firstRefusal === 'artifacts_unavailable' && hostNodeRefusal === 'host_node_missing') {
    return `${CLIENT_ARTIFACTS_NO_HOST_NODE_MESSAGE} (Orca's Node: ${firstRefusal})`
  }
  if (hostNodeRefusal === 'install_failed' && reason !== 'home_noexec') {
    return `${HOST_NODE_FALLBACK_FAILED_MESSAGE} (Orca's Node: ${firstRefusal ?? 'none'})`
  }
  if (hostOs === 'win32') {
    return `${WINDOWS_NO_HOST_NODE_MESSAGE} (Orca's Node: ${firstRefusal ?? 'none'})`
  }
  if (reason === 'home_noexec') {
    return noexec === 'remembered'
      ? REMEMBERED_NOEXEC_MESSAGE
      : REMOTE_RUNTIME_UNAVAILABLE_MESSAGES.home_noexec
  }
  const base = REMOTE_RUNTIME_UNAVAILABLE_MESSAGES.no_runtime
  return firstRefusal ? `${base} (Orca's Node: ${firstRefusal})` : base
}
