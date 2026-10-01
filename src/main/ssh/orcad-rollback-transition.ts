/** The locked, journaled half of `rollbackOrcad`. */
import { randomUUID } from 'node:crypto'
import type { OrcadRollbackOptions, OrcadRollbackResult } from './orcad-remote-rollback'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { withRolledBackVersion } from './orcad-activation-record'
import { writeOrcadActivationRecord } from './orcad-activation-record-store'
import { evaluateOrcadActivation } from './orcad-activation-gate'
import { assessOrcadRollback } from './orcad-update-plan'
import { ORCAD_LOG_FILENAME, type OrcadReadinessParse } from './orcad-remote-launch'
import {
  captureOrcadStateSnapshotCommand,
  newestStateMtimeCommand,
  orcadRollbackRescueDirName,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotPresence,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { joinRemotePath } from './ssh-remote-platform'
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import type { OrcadRollbackTransaction } from './orcad-activation-transaction'
import {
  createOrcadRollbackTransaction,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue
} from './orcad-activation-transaction-transitions'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  execOrcadRemote,
  launchOrcadAndAwaitReadiness,
  withoutAbortSignal
} from './orcad-remote-runtime-control'
import {
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  stopOrcadSlot,
  ORCAD_SLOT_STOP_WAIT_SECONDS,
  type OrcadSlotIdentity
} from './orcad-recovery-slot'
import { orcadSnapshotPath, recoverOrcadIncumbent } from './orcad-incumbent-recovery'

/** A confirmed failure reads as no answer; an unconfirmed one propagates and keeps the fence. */
async function execOrEmpty(options: OrcadRollbackOptions, command: string): Promise<string> {
  return execOrcadRemote(options, command).catch((error: unknown) => {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return ''
  })
}

async function stateWritesSinceActivation(options: OrcadRollbackOptions): Promise<boolean | null> {
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt ?? '') / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    await execOrEmpty(options, newestStateMtimeCommand(options.host, options.userDataDir))
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function rollbackOrcadLocked(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl
): Promise<OrcadRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  const snapshot = options.record.snapshot
  const presence = snapshot
    ? parseOrcadSnapshotPresence(
        await execOrEmpty(
          options,
          probeOrcadStateSnapshotCommand(options.host, orcadSnapshotPath(options, snapshot.dirName))
        )
      )
    : 'absent'
  const safety = assessOrcadRollback({
    record: options.record,
    snapshotPresent: presence === 'unverifiable' ? null : presence === 'present',
    census: options.census,
    targetDaemonProtocol: options.targetDaemonProtocol,
    stateWritesSinceActivation: await stateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }
  if (!snapshot || !options.record.active) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_no_active',
      reason: 'No orcad version is active on this host, so there is nothing to roll back from.'
    }
  }
  let incumbent: OrcadSlotIdentity
  try {
    incumbent = await resolveOrcadSlotIdentity(options, options.record.active)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'orcad_rollback_active_identity_unverifiable',
      reason: `The active orcad identity could not be verified: ${errorMessage(error)} Nothing was changed.`
    }
  }

  const startedAt = now()
  let transaction: OrcadRollbackTransaction = createOrcadRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: incumbent.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, startedAt),
    rescueDirName: orcadRollbackRescueDirName(incumbent.version, startedAt.getTime()),
    now: startedAt
  })
  await writeOrcadActivationTransaction(options, transaction)
  lock.retainOnError()

  const stopped = await stopOrcadSlot(options, incumbent.remoteDir, false)
  if (!orcadStopFreedTheHost(stopped)) {
    if (stopped === 'still-running') {
      lock.retain()
    }
    return {
      outcome: 'failed',
      code: 'orcad_rollback_stop_incomplete',
      reason:
        `Could not verify that orcad ${incumbent.version} exited within ` +
        `${ORCAD_SLOT_STOP_WAIT_SECONDS}s (${stopped}). Nothing was restored. Orca requires ` +
        'matching runtime readiness before signaling an incumbent and confirmed exit before ' +
        'replacing its state.'
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeOrcadActivationTransaction(options, transaction)

  const rescue = parseOrcadSnapshotCapture(
    await execOrEmpty(
      options,
      captureOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        orcadSnapshotPath(options, transaction.rescue.dirName)
      )
    )
  )
  if (rescue === 'failed') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent, null)
    return {
      outcome: 'failed',
      code: 'orcad_rollback_rescue_snapshot_failed',
      reason:
        'The current state could not be preserved in a rescue snapshot, so the data root was ' +
        `not replaced. ${recovered}`
    }
  }
  transaction = withOrcadRollbackRescue(transaction, rescue, now())
  await writeOrcadActivationTransaction(options, transaction)

  // Why between stop and start: the older build must never load the newer build's state.
  const restored = parseOrcadSnapshotRestore(
    await execOrEmpty(
      options,
      restoreOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        orcadSnapshotPath(options, snapshot.dirName)
      )
    )
  )
  if (restored !== 'restored') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent, null)
    return {
      outcome: 'failed',
      code: 'orcad_rollback_restore_failed',
      reason: `The pre-activation snapshot could not be restored (${restored}). ${recovered}`
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeOrcadActivationTransaction(options, transaction)

  const targetDir = orcadSlotDir(options, safety.target)
  let parsed: OrcadReadinessParse | null = null
  let launchError: unknown
  try {
    parsed = await launchOrcadAndAwaitReadiness(options, {
      remoteInstallDir: targetDir,
      nodePath: options.nodePath,
      fullVersion: safety.target,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port
    })
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    launchError = error
  }
  const verdict = evaluateOrcadActivation(parsed?.state === 'ready' ? parsed.readiness : null, {
    buildHash: options.targetBuildHash,
    fullVersion: safety.target
  })
  if (verdict.decision === 'reject') {
    const reason =
      launchError === undefined
        ? verdict.reason
        : `It failed while starting: ${errorMessage(launchError)}`
    const targetStop = await stopOrcadSlot(withoutAbortSignal(options), targetDir, true).catch(
      (error: unknown) => `unverifiable: ${errorMessage(error)}`
    )
    const recovered =
      targetStop === 'stopped' || targetStop === 'already-exited'
        ? await putIncumbentBack(options, lock, transaction, incumbent, safety.target)
        : retainedAfterTargetStop(lock, targetStop)
    return {
      outcome: 'failed',
      code: launchError === undefined ? verdict.code : 'orcad_rollback_target_launch_failed',
      reason:
        `The rollback target ${safety.target} did not come up healthy: ${reason} ${recovered} ` +
        `Its stderr is at ${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
    }
  }

  // The record is written last: until the target is proven serving, `active` still names the
  // version an operator would need to bring back.
  transaction = withOrcadRollbackPhase(transaction, 'target-ready', now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict
  }
}

function retainedAfterTargetStop(lock: OrcadActivationLockControl, stopped: string): string {
  lock.retain()
  return (
    `The target could not be confirmed stopped (${stopped}), so the rescue snapshot was not ` +
    'restored over state it may still own. This host requires recovery.'
  )
}

/** Restores the rescued state when it was replaced, then restarts the incumbent. */
async function putIncumbentBack(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl,
  transaction: OrcadRollbackTransaction,
  incumbent: OrcadSlotIdentity,
  launchedVersion: string | null
): Promise<string> {
  try {
    const recovery = await recoverOrcadIncumbent(withoutAbortSignal(options), {
      transactionStartedAt: transaction.startedAt,
      launchedVersion,
      incumbent,
      restoreState: transaction.rescue.state === 'pending' ? null : transaction.rescue,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    lock.recovered()
    return `orcad ${incumbent.version} was restored and is serving again.`
  } catch (error) {
    lock.retain()
    return `Restoring orcad ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
