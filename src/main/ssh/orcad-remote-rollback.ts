/**
 * Going back to the previously active orcad.
 *
 * Rollback is a state operation, not a binary swap. The version dirs are immutable and both
 * are still on disk, so pointing at the old one is trivial; what is not trivial is that both
 * versions share ONE data root, outside either dir. A newer orcad migrates that root on load
 * — and Orca's persisted state carries no schema version to migrate against, so the older
 * build cannot be shown to read the result. Rollback therefore restores the pre-activation
 * snapshot, and refuses when restoring it would orphan work (`assessOrcadRollback`).
 *
 * The order below is the whole safety argument: stop, then restore, then start. Restoring
 * under a running orcad would replace the store beneath a process holding it open, and
 * starting before restoring would let the old build migrate the new build's state — the
 * failure this is meant to avoid, arrived at from the other side.
 */
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { writeRelayFile } from './ssh-relay-install-transfers'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  ORCAD_STATE_SNAPSHOT_DIR,
  serializeOrcadActivationRecord,
  withRolledBackVersion,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { assessOrcadRollback, type OrcadTerminalCensus } from './orcad-update-plan'
import { evaluateOrcadActivation, type OrcadActivationVerdict } from './orcad-activation-gate'
import {
  ORCAD_LOG_FILENAME,
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand
} from './orcad-remote-launch'
import {
  newestStateMtimeCommand,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import { orcadActivationPath } from './orcad-activation-record-store'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'

export type OrcadRollbackOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  record: OrcadActivationRecord
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  census: OrcadTerminalCensus
  /** Expected build hash of the rollback target, from the client's copy of those bytes. */
  targetBuildHash: string
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadRollbackResult =
  | { outcome: 'rolled-back'; target: string; discarded: string[]; verdict: OrcadActivationVerdict }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const READINESS_POLL_MS = 500
const STOP_WAIT_SECONDS = 20

function exec(options: OrcadRollbackOptions, command: string): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal: options.signal
  })
}

function snapshotDirPath(options: OrcadRollbackOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    ORCAD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

/** Has the store been written since activation? `null` when it cannot be established. */
async function readStateWritesSinceActivation(
  options: OrcadRollbackOptions
): Promise<boolean | null> {
  if (!options.record.activatedAt) {
    return null
  }
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt) / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    await exec(options, newestStateMtimeCommand(options.host, options.userDataDir)).catch(() => '')
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function rollbackOrcad(
  options: OrcadRollbackOptions
): Promise<OrcadRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  const snapshotPresent = options.record.snapshot
    ? (
        await exec(
          options,
          probeOrcadStateSnapshotCommand(
            options.host,
            snapshotDirPath(options, options.record.snapshot.dirName)
          )
        ).catch(() => 'ABSENT')
      ).trim() === 'PRESENT'
    : false

  const safety = assessOrcadRollback({
    record: options.record,
    snapshotPresent,
    census: options.census,
    stateWritesSinceActivation: await readStateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }

  if (options.record.active) {
    const outgoingDir = computeRemoteInstallDir(
      ORCAD_INSTALL_MODEL,
      options.remoteHome,
      options.record.active
    )
    const stopped = parseOrcadStopOutcome(
      await exec(
        options,
        stopOrcadCommand(options.host, outgoingDir, { waitSeconds: STOP_WAIT_SECONDS })
      )
    )
    if (!orcadStopFreedTheHost(stopped)) {
      return {
        outcome: 'failed',
        code: 'orcad_rollback_stop_incomplete',
        reason:
          `orcad ${options.record.active} did not exit within ${STOP_WAIT_SECONDS}s of SIGTERM ` +
          `(${stopped}). Nothing was restored — the store is untouched and the host is still ` +
          'serving the version you tried to leave.'
      }
    }
  }

  // Why between stop and start: the store must be replaced while no orcad holds it, and
  // before the older build gets a chance to migrate the newer build's state.
  const restored = parseOrcadSnapshotRestore(
    await exec(
      options,
      restoreOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        // Guarded by `assessOrcadRollback`: `unsafe` covers a missing snapshot.
        snapshotDirPath(options, options.record.snapshot?.dirName ?? '')
      )
    ).catch(() => 'FAILED')
  )
  if (restored !== 'restored') {
    return {
      outcome: 'failed',
      code: 'orcad_rollback_restore_failed',
      reason:
        `The pre-activation snapshot could not be restored (${restored}). orcad is stopped and ` +
        'the data root may be partially replaced. Do NOT start the older build against it; ' +
        `re-deploy ${options.record.active ?? 'the newer version'}, which can read what is there.`
    }
  }

  const targetDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    safety.target
  )
  await exec(
    options,
    orcadLaunchCommand(options.host, {
      remoteInstallDir: targetDir,
      nodePath: options.nodePath,
      fullVersion: safety.target,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port
    })
  )
  const deadline = Date.now() + (options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let parsed = parseOrcadReadinessOutput('')
  while (Date.now() < deadline && parsed.state === 'pending') {
    options.signal?.throwIfAborted()
    parsed = parseOrcadReadinessOutput(
      await exec(options, readOrcadReadinessCommand(options.host, targetDir))
    )
    if (parsed.state === 'pending') {
      await sleep(READINESS_POLL_MS)
    }
  }
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: options.targetBuildHash,
    fullVersion: safety.target
  })
  if (verdict.decision === 'reject') {
    return {
      outcome: 'failed',
      code: verdict.code,
      reason:
        `The rollback target ${safety.target} did not come up healthy: ${verdict.reason} The ` +
        `store has been restored to its pre-activation state. Its stderr is at ` +
        `${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
    }
  }

  // Why the record is written last: until the target is proven serving, `active` still names
  // the version an operator would need to bring back, and `previous` still names this target.
  await writeRelayFile(
    options.conn,
    options.host,
    orcadActivationPath(options.host, options.remoteHome),
    serializeOrcadActivationRecord(withRolledBackVersion(options.record, now())),
    { signal: options.signal }
  )
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict
  }
}
