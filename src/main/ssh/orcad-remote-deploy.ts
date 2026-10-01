/**
 * Activate installed bytes only after the candidate proves healthy. A rejected candidate
 * allows restarting the incumbent only when profile state is provably unchanged; otherwise
 * preserve current state and the prelaunch snapshot for explicit recovery.
 *
 * Every activation runs under the host's activation fence and journal
 * (`orcad-activation-lock.ts`), so an interrupted one is recoverable to exactly one slot.
 */
import { join } from 'node:path'
import type { SshConnection } from './ssh-connection'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir, readLocalFullVersion } from './ssh-relay-versioned-install'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import type { OrcadActivationVerdict } from './orcad-activation-gate'
import type { OrcadTerminalCensus } from './orcad-update-plan'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { installOrcadBundle } from './orcad-remote-install'
import { getAppEnvironment } from '../../shared/app-environment'
import type { ServerTarget } from '../../shared/node-runtime-pin'
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/orcad-profile-preflight'
import { materializeOrcadArtifact } from './orcad-artifact-materializer'
import { readOrcadBundleTarget, resolveOrcadDeploymentTarget } from './orcad-deployment-target'
import { materializeNodeRuntimeArchive } from './pinned-runtime-materializer'
import {
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock
} from './orcad-activation-lock'
import { activateInstalledOrcad } from './orcad-installed-activation'

export type OrcadDeployOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  /** An already assembled bundle; otherwise materialize the packaged template for this host. */
  localOrcadDir?: string
  /** The bundle's server target; read from `localOrcadDir` or probed when absent. */
  target?: ServerTarget
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
  force?: boolean
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: OrcadActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

/** Activate on a healthy verdict; retain changed candidate state for explicit recovery. */
export async function deployOrcad(input: OrcadDeployOptions): Promise<OrcadDeployResult> {
  assertPosixOrcadHost(input.host)
  const target =
    input.target ??
    (input.localOrcadDir
      ? readOrcadBundleTarget(input.localOrcadDir)
      : await resolveOrcadDeploymentTarget(input))
  const options = {
    ...input,
    target,
    readinessTimeoutMs: resolveOrcadActivationReadinessTimeout(
      input.readinessTimeoutMs,
      ORCAD_STARTUP_READINESS_TIMEOUT_MS
    ),
    nodeRuntimeArchive: () =>
      materializeNodeRuntimeArchive(
        target,
        input.runtimeCacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
        { signal: input.signal }
      ),
    localOrcadDir:
      input.localOrcadDir ?? (await materializeOrcadArtifact(target, { signal: input.signal }))
  }
  const fullVersion = readLocalFullVersion(options.localOrcadDir)
  const remoteDir = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, options.remoteHome, fullVersion)
  // Fail fast before upload; the activation re-reads it under the fence.
  await readOrcadActivationRecord(options)

  await installOrcadBundle(options, fullVersion, remoteDir)

  return withOrcadActivationLock(options, (lock) =>
    activateInstalledOrcad(options, fullVersion, remoteDir, lock)
  )
}
