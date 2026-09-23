/**
 * Activate installed bytes only after the candidate proves healthy. A rejected candidate
 * allows restarting the incumbent only when profile state is provably unchanged; otherwise
 * preserve current state and the prelaunch snapshot for explicit recovery.
 */
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { shellEscape } from './ssh-connection-utils'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import {
  abandonInstall,
  computeRemoteInstallDir,
  finalizeInstall,
  isRemoteInstallComplete,
  readLocalFullVersion
} from './ssh-relay-versioned-install'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  ORCAD_STATE_SNAPSHOT_DIR,
  serializeOrcadActivationRecord,
  withActivatedVersion,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from './orcad-activation-record'
import { orcadActivationPath, readOrcadActivationRecord } from './orcad-activation-record-store'
import { evaluateOrcadActivation, type OrcadActivationVerdict } from './orcad-activation-gate'
import { planOrcadUpdate, type OrcadTerminalCensus } from './orcad-update-plan'
import {
  ORCAD_LOG_FILENAME,
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand
} from './orcad-remote-launch'
import { rejectedOrcadStateRecoveryRefusal, stopOutgoingOrcad } from './orcad-remote-deploy-stop'
import {
  captureOrcadStateSnapshotCommand,
  orcadSnapshotDirName,
  parseOrcadSnapshotCapture
} from './orcad-state-snapshot'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { computeLocalOrcadBuildHash } from './orcad-local-build-hash'

export type OrcadDeployOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  /** Local `out/orcad`, containing the artifacts and the `.version` marker. */
  localOrcadDir: string
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

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const READINESS_POLL_MS = 500
const STOP_WAIT_SECONDS = 20

function exec(
  options: OrcadDeployOptions,
  command: string,
  signal = options.signal
): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal
  })
}

function baseDir(options: OrcadDeployOptions): string {
  return joinRemotePath(options.host, options.remoteHome, RELAY_REMOTE_DIR)
}

/** Install the bytes under `orcad-<version>/`, using the relay's install transaction. */
async function installOrcadBundle(
  options: OrcadDeployOptions,
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  if (
    await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return
  }
  await acquireInstallLock(options.conn, remoteDir, options.host, { signal: options.signal })
  try {
    // Re-probe under the lock: a sibling deploy may have finished while we waited.
    if (
      await isRemoteInstallComplete(options.conn, ORCAD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      return
    }
    await uploadRelayDirectory(options.conn, options.localOrcadDir, remoteDir, options.host, {
      signal: options.signal
    })
    const { host } = options
    if (host.os !== 'win32') {
      // SFTP creates uploaded files with 0644 even when the source binary is executable.
      const binaryPath = joinRemotePath(host, remoteDir, 'ripgrep', host.relayPlatform, 'rg')
      await exec(options, `chmod 755 ${shellEscape(binaryPath)}`)
    }
    await writeRelayFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, ORCAD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal: options.signal }
    )
    await finalizeInstall(options.conn, remoteDir, options.host, { signal: options.signal })
  } catch (error) {
    // Leave a recoverable partial rather than a dir that probes complete.
    await abandonInstall(options.conn, remoteDir, options.host)
    throw error
  }
}

async function captureSnapshot(
  options: OrcadDeployOptions,
  fullVersion: string,
  outgoingVersion: string | null,
  takenAt: Date
): Promise<OrcadStateSnapshot | null> {
  // The caller has already stopped the outgoing runtime. This is required once profile state
  // includes SQLite: a tar of a live WAL, main database, and SHM file is not a SQLite backup.
  const dirName = orcadSnapshotDirName(fullVersion, takenAt.getTime())
  const snapshotDir = joinRemotePath(
    options.host,
    baseDir(options),
    ORCAD_STATE_SNAPSHOT_DIR,
    dirName
  )
  const capture = parseOrcadSnapshotCapture(
    await exec(
      options,
      captureOrcadStateSnapshotCommand(options.host, options.userDataDir, snapshotDir)
    )
  )
  if (capture === 'failed') {
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}. Orca's ` +
        'persisted state carries no schema version, so without a snapshot a rollback has no ' +
        'way back. Refusing to activate.'
    )
  }
  if (capture === 'empty') {
    // Nothing on the host to lose: a first deployment. Rollback will correctly report that
    // it has no snapshot, rather than restoring an archive of nothing over a populated root.
    return null
  }
  return {
    dirName,
    takenBeforeVersion: fullVersion,
    readableByVersion: outgoingVersion,
    takenAt: takenAt.toISOString()
  }
}

async function launchAndAwaitReadiness(
  options: OrcadDeployOptions,
  remoteInstallDir: string,
  fullVersion: string
): Promise<ReturnType<typeof parseOrcadReadinessOutput>> {
  await exec(
    options,
    orcadLaunchCommand(options.host, { ...options, remoteInstallDir, fullVersion })
  )
  const deadline = Date.now() + (options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseOrcadReadinessOutput('')
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    last = parseOrcadReadinessOutput(
      await exec(options, readOrcadReadinessCommand(options.host, remoteInstallDir))
    )
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_POLL_MS)
  }
  return last
}

/** Restart the incumbent only when the candidate left shared state unchanged. */
async function restoreIncumbent(
  options: OrcadDeployOptions,
  record: OrcadActivationRecord,
  candidateDir?: string,
  snapshot?: OrcadStateSnapshot | null
): Promise<string> {
  if (candidateDir) {
    const stopped = parseOrcadStopOutcome(
      await exec(
        options,
        stopOrcadCommand(options.host, candidateDir, {
          waitSeconds: STOP_WAIT_SECONDS,
          justLaunched: true
        })
      )
    )
    if (!orcadStopFreedTheHost(stopped)) {
      return `The candidate itself did not stop (${stopped}); the host may still be serving the rejected build.`
    }
  }
  if (!record.active) {
    return 'No previous version was active, so this host is now serving nothing.'
  }
  if (candidateDir) {
    const snapshotDir = snapshot
      ? joinRemotePath(options.host, baseDir(options), ORCAD_STATE_SNAPSHOT_DIR, snapshot.dirName)
      : undefined
    const refusal = await rejectedOrcadStateRecoveryRefusal(options, record.active, snapshotDir)
    if (refusal) {
      return refusal
    }
  }
  const incumbentDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    record.active
  )
  const parsed = await launchAndAwaitReadiness(options, incumbentDir, record.active)
  return parsed.state === 'ready'
    ? `orcad ${record.active} was restarted and is serving again.`
    : `orcad ${record.active} was relaunched but has not published readiness; this host may be down.`
}

/** Activate on a healthy verdict; retain changed candidate state for explicit recovery. */
export async function deployOrcad(options: OrcadDeployOptions): Promise<OrcadDeployResult> {
  const now = options.now ?? ((): Date => new Date())
  const fullVersion = readLocalFullVersion(options.localOrcadDir)
  const remoteDir = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const record = await readOrcadActivationRecord(options)

  await installOrcadBundle(options, fullVersion, remoteDir)

  const plan = planOrcadUpdate({
    record,
    candidateVersion: fullVersion,
    census: options.census,
    ...(options.force !== undefined ? { force: options.force } : {})
  })
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  if (plan.action === 'defer') {
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: plan.code,
      reason: plan.reason
    }
  }

  if (record.active) {
    const stopped = await stopOutgoingOrcad(options, record.active)
    if (!orcadStopFreedTheHost(stopped)) {
      return {
        outcome: 'installed-not-activated',
        fullVersion,
        code: 'orcad_outgoing_stop_incomplete',
        reason:
          `Could not verify that orcad ${record.active} exited (${stopped}). ` +
          'No snapshot was taken and the candidate was not started. Orca requires matching ' +
          'runtime readiness before signaling an incumbent and confirmed exit before snapshotting.'
      }
    }
  }

  // A live SQLite WAL is not a backup boundary: tar can observe the main file, WAL and SHM
  // at different points and restore a set SQLite cannot recover. Stop the incumbent first so
  // its final durable flush has completed before capturing the pre-activation state.
  let snapshot: OrcadStateSnapshot | null = null
  if (record.active) {
    try {
      snapshot = await captureSnapshot(options, fullVersion, record.active, now())
    } catch (error) {
      const restored = await restoreIncumbent(options, record).catch(
        (restartError: unknown) =>
          `The incumbent could not be restarted: ${
            restartError instanceof Error ? restartError.message : String(restartError)
          }`
      )
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} The incumbent was stopped ` +
          `before snapshotting; ${restored}`
      )
    }
  }

  const parsed = await launchAndAwaitReadiness(options, remoteDir, fullVersion)
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: computeLocalOrcadBuildHash(options.localOrcadDir),
    fullVersion
  })
  if (verdict.decision === 'reject') {
    const restored = await restoreIncumbent(options, record, remoteDir, snapshot)
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: verdict.code,
      reason:
        `${verdict.reason} Candidate stderr is at ` +
        `${joinRemotePath(options.host, remoteDir, ORCAD_LOG_FILENAME)}. ${restored}`
    }
  }

  await writeRelayFile(
    options.conn,
    options.host,
    orcadActivationPath(options.host, options.remoteHome),
    serializeOrcadActivationRecord(withActivatedVersion(record, fullVersion, snapshot, now())),
    { signal: options.signal }
  )
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}
