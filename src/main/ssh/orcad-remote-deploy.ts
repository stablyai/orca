/**
 * Installing orcad on a host and, only if it proves itself, making it the active one.
 *
 * The install half is the relay's transaction, parameterized: the same per-version lock,
 * staged SFTP write, `.install-complete` sentinel and stale-lock recovery, under
 * `orcad-<version>/` instead of `relay-<version>/`. That is what §02 marks reusable.
 *
 * The activation half has no relay equivalent, because the relay has no notion of a version
 * being *selected*. Bytes landing in a versioned directory neither picks a version nor rolls
 * one back; the activation record does, and it is written only after the candidate publishes
 * a health payload that survives `evaluateOrcadActivation`. A rejected candidate leaves the
 * previous version running and its own bytes on disk — nothing is lost, and a retry costs no
 * upload.
 */

import type { SshConnection } from './ssh-connection'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir, readLocalFullVersion } from './ssh-relay-versioned-install'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import type { OrcadActivationVerdict } from './orcad-activation-gate'
import type { OrcadTerminalCensus } from './orcad-update-plan'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { withOrcadActivationLock } from './orcad-activation-lock'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { installOrcadBundle } from './orcad-bundle-installation'
import { activateInstalledOrcad } from './orcad-installed-activation'

export type OrcadDeployOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  /** Local `out/orcad`, containing the artifacts and the `.version` marker. */
  localOrcadDir: string
  /** Native slot selected after probing the execution host. */
  buildTarget: OrcadBunTarget
  nodePath?: string
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
  | {
      outcome: 'installed-and-activated'
      fullVersion: string
      verdict: OrcadActivationVerdict
      readiness: ServeReadiness
    }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

export async function deployOrcad(options: OrcadDeployOptions): Promise<OrcadDeployResult> {
  const now = options.now ?? ((): Date => new Date())
  const fullVersion = readLocalFullVersion(options.localOrcadDir)
  const remoteDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    fullVersion,
    options.host.pathFlavor
  )
  // Fail fast before upload, then re-read under the activation lock after the install.
  await readOrcadActivationRecord(options)
  await installOrcadBundle(options, fullVersion, remoteDir)
  return withOrcadActivationLock(options, (lock) =>
    activateInstalledOrcad(options, fullVersion, remoteDir, now, lock)
  )
}
