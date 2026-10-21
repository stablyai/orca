/**
 * Activate installed bytes only after the candidate proves healthy. A rejected candidate
 * allows restarting the incumbent only when profile state is provably unchanged; otherwise
 * preserve current state and the prelaunch snapshot for explicit recovery.
 *
 * Every activation runs under the host's activation fence and journal
 * (`orcad-activation-lock.ts`), so an interrupted one is recoverable to exactly one slot.
 */
import { logOrcadActivationOutcome } from '../managed-server/activation/orcad-activation-outcome-log'
import { join } from 'node:path'
import type { OrcadHostTransport } from './orcad-host-transport'
import { ORCAD_INSTALL_MODEL } from '../managed-server/install/remote-install-model'
import {
  computeRemoteInstallDir,
  readLocalFullVersion
} from '../managed-server/install/remote-versioned-install'
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import type { OrcadActivationVerdict } from '../managed-server/activation/orcad-activation-gate'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { installOrcadBundle } from '../managed-server/install/orcad-remote-install'
import { getAppEnvironment } from '../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/orcad-profile-preflight'
import { materializeOrcadArtifact } from '../orcad/orcad-artifact-materializer'
import { readOrcadBundleTarget } from './orcad-deployment-target'
import { resolveOrcadRuntimeTarget } from '../managed-server/lifecycle/orcad-runtime-target'
import {
  materializeNodeRuntimeArchive,
  nodeRuntimeArchiveCachePath
} from '../node-runtime/pinned-runtime-materializer'
import {
  orcadActivationFenceExists,
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock
} from '../managed-server/activation/orcad-activation-lock'
import { activateInstalledOrcad } from './orcad-installed-activation'
import { orcadActivationFenceRefusal } from '../managed-server/activation/orcad-activation-fence-hold'

export type OrcadDeployOptions = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  /** An already assembled bundle; otherwise materialize the packaged template for this host. */
  localOrcadDir?: string
  /** The bundle's runtime target; read from `localOrcadDir` or probed when absent. */
  target?: NodeRuntimeTarget
  /** Where the pinned runtime archive is cached; defaults beside the orcad artifact cache. */
  runtimeCacheRoot?: string
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  /**
   * Live-terminal counts, supplied by the caller from the runtime it is already connected
   * to. Not probed here: counting the daemon's sessions needs its protocol, and a deploy
   * that guessed zero from silence would be the "loss of contact means death" mistake.
   */
  census: OrcadTerminalCensus
  /**
   * The record `census` was counted against; defaults to the one read before upload. A different
   * incumbent found under the fence makes the census unverifiable rather than wrongly zero.
   */
  censusRecord?: OrcadActivationRecord
  /**
   * Counts again under the fence just before the incumbent stops, so a terminal opened during
   * the upload still defers the update. Required, since `census` may predate a long upload.
   * Called only while the incumbent is the one counted; any failure must read as unverifiable.
   */
  recountCensus: () => Promise<OrcadTerminalCensus>
  /**
   * Reopens the terminal admission `recountCensus` closes, when the update then leaves the
   * incumbent running. Best effort: the server reopens on its own once the fence lapses.
   */
  releaseIncumbentAdmission: () => Promise<void>
  force?: boolean
  /** The Orca app version activating, recorded so an older client never downgrades the host. */
  appVersion?: string
  /**
   * Re-applies the caller's version policy to the record read under the host fence, since another
   * desktop can activate or stop a build while this one uploads. A reason refuses the activation.
   */
  admitRecord?: (record: OrcadActivationRecord, candidateVersion: string) => string | null
  readinessTimeoutMs?: number
  /** WSL only; SSH hosts always re-hash the runtime (see `installOrcadBundle`). */
  recordedNodeRuntimeProbe?: boolean
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: OrcadActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

/** Activate on a healthy verdict; retain changed candidate state for explicit recovery. */
export async function deployOrcad(
  input: OrcadDeployOptions,
  retryClearedFence = true
): Promise<OrcadDeployResult> {
  const target =
    input.target ??
    (input.localOrcadDir
      ? readOrcadBundleTarget(input.localOrcadDir)
      : await resolveOrcadRuntimeTarget(input))
  const runtimeCacheRoot =
    input.runtimeCacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const options = {
    ...input,
    target,
    readinessTimeoutMs: resolveOrcadActivationReadinessTimeout(
      input.readinessTimeoutMs,
      ORCAD_STARTUP_READINESS_TIMEOUT_MS
    ),
    nodeRuntimeArchive: () =>
      materializeNodeRuntimeArchive(target, runtimeCacheRoot, { signal: input.signal }),
    nodeRuntimeOfflineArchivePath: nodeRuntimeArchiveCachePath(target, runtimeCacheRoot),
    localOrcadDir:
      input.localOrcadDir ?? (await materializeOrcadArtifact(target, { signal: input.signal }))
  }
  const fullVersion = readLocalFullVersion(options.localOrcadDir)
  const remoteDir = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const held = async (): Promise<OrcadDeployResult> => {
    const { cleared, ...refusal } = await orcadActivationFenceRefusal(options, 'update')
    // Once: a second abandoned fence means something keeps leaving them, so report it.
    if (cleared && retryClearedFence) {
      return deployOrcad({ ...input, target, localOrcadDir: options.localOrcadDir }, false)
    }
    return { outcome: 'installed-not-activated', fullVersion, ...refusal }
  }
  // Fail fast before upload; the activation re-reads both under the fence.
  const preUploadRecord = await readOrcadActivationRecord(options)
  const censusRecord = options.censusRecord ?? preUploadRecord
  // An unanswered probe only skips this shortcut: the fence acquisition itself still decides.
  if (await orcadActivationFenceExists(options).catch(() => false)) {
    return held()
  }

  await installOrcadBundle(options, fullVersion, remoteDir)

  return logOrcadActivationOutcome(
    `update to ${fullVersion}`,
    () =>
      withOrcadActivationLock(
        options,
        (lock) =>
          activateInstalledOrcad({ ...options, censusRecord }, fullVersion, remoteDir, lock),
        held
      ),
    ['installed-and-activated', 'already-active']
  )
}
