/** Activate under a durable host fence/journal only after candidate readiness. Recover the incumbent only with safe profile state; retain changed state/snapshot for explicit recovery. */
import { logOrcadActivationOutcome } from '../activation/orcad-activation-outcome-log'
import { join } from 'node:path'
import type { OrcadHostTransport } from './orcad-host-transport'
import type { OrcadUpdateForce } from '../activation/orcad-update-plan'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir, readLocalFullVersion } from './remote-versioned-install'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import type { OrcadActivationVerdict } from '../activation/orcad-activation-gate'
import type { OrcadTerminalCensus } from '../../../shared/orcad-terminal-census'
import type { RemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { installOrcadBundle } from './orcad-remote-install'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/orcad-profile-preflight'
import { materializeOrcadArtifact } from '../../orcad/artifact-slots/orcad-artifact-materializer'
import { readOrcadBundleTarget } from './orcad-deployment-target'
import { resolveOrcadRuntimeTarget } from '../lifecycle/orcad-runtime-target'
import {
  orcadNodeRuntimeInstallOptions,
  type NodeRuntimeDownloadBudget
} from './orcad-node-runtime-install-options'
import {
  orcadActivationFenceExists,
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock
} from '../activation/orcad-activation-lock'
import { activateInstalledOrcad } from '../activation/orcad-installed-activation'
import { orcadActivationFenceRefusal } from '../activation/orcad-activation-fence-hold'

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
  /** Caller supplies a protocol-aware census; unanswered host evidence must never become zero live terminals. */
  census: OrcadTerminalCensus
  /** Bind census to its incumbent record; a changed locked record makes earlier counts unverifiable. */
  censusRecord?: OrcadActivationRecord
  /** WSL only: the record and fence this connect read moments ago; skips the same pre-upload reads. */
  preRead?: { record: OrcadActivationRecord; fenceOpen: boolean }
  /** WSL only: a same-version deploy skips its fence; the caller's wake re-checks under its own. */
  sameVersionFencedByCaller?: boolean
  /** Recount under fence just before stopping the same incumbent; uploads may outdate initial counts and failures stay unverifiable. */
  recountCensus: () => Promise<OrcadTerminalCensus>
  /** Best-effort reopen when incumbent keeps serving; admission also expires server-side. */
  releaseIncumbentAdmission: () => Promise<void>
  force?: OrcadUpdateForce
  /** The Orca app version activating, recorded so an older client never downgrades the host. */
  appVersion?: string
  /** Reapply version policy under lock because peer activation/stop may land during upload. */
  admitRecord?: (record: OrcadActivationRecord, candidateVersion: string) => string | null
  readinessTimeoutMs?: number
  /** WSL only; SSH hosts always re-hash the runtime (see `installOrcadBundle`). */
  recordedNodeRuntimeProbe?: boolean
  /** WSL only: bounded Node runtime downloads; SSH keeps the default timing. */
  nodeRuntimeDownload?: NodeRuntimeDownloadBudget
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: OrcadActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | {
      outcome: 'installed-not-activated'
      fullVersion: string
      code: string
      reason: string
      /** The candidate's own preflight or launch check failed; a deferral never sets this. */
      startCheckFailed?: true
      /** This deploy uploaded the slot rather than finding it already installed. */
      freshlyInstalled?: true
    }

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
    ...orcadNodeRuntimeInstallOptions(target, runtimeCacheRoot, input),
    localOrcadDir:
      input.localOrcadDir ?? (await materializeOrcadArtifact(target, { signal: input.signal }))
  }
  const fullVersion = readLocalFullVersion(options.localOrcadDir)
  const remoteDir = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const held = async (): Promise<OrcadDeployResult> => {
    const { cleared, ...refusal } = await orcadActivationFenceRefusal(options, 'update')
    // Retry one cleared abandoned fence; repeated abandonment must surface to the caller.
    if (cleared && retryClearedFence) {
      return deployOrcad(
        {
          ...input,
          preRead: undefined,
          sameVersionFencedByCaller: undefined,
          target,
          localOrcadDir: options.localOrcadDir
        },
        false
      )
    }
    return { outcome: 'installed-not-activated', fullVersion, ...refusal }
  }
  // Refuse before upload, then re-read both admission inputs under fence.
  const preUploadRecord = options.preRead?.record ?? (await readOrcadActivationRecord(options))
  const censusRecord = options.censusRecord ?? preUploadRecord
  // An unanswered probe only skips this shortcut; lock acquisition still arbitrates.
  if (
    !options.preRead?.fenceOpen &&
    (await orcadActivationFenceExists(options).catch(() => false))
  ) {
    return held()
  }

  const installed = await installOrcadBundle(options, fullVersion, remoteDir)
  if (options.sameVersionFencedByCaller && preUploadRecord.active === fullVersion) {
    return { outcome: 'already-active', fullVersion }
  }

  const result = await logOrcadActivationOutcome(
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
  return installed === 'uploaded' && result.outcome === 'installed-not-activated'
    ? { ...result, freshlyInstalled: true }
    : result
}
