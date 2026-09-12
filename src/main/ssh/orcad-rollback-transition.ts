import { randomUUID } from 'node:crypto'
import type { OrcadRollbackOptions, OrcadRollbackResult } from './orcad-remote-rollback'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { withRolledBackVersion } from './orcad-activation-record'
import { assessOrcadRollback } from './orcad-update-plan'
import { ORCAD_LOG_FILENAME } from './orcad-remote-launch'
import {
  orcadRollbackRescueDirName,
  parseOrcadSnapshotPresence,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { writeOrcadActivationRecord } from './orcad-activation-record-store'
import { joinRemotePath } from './ssh-remote-platform'
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import {
  createOrcadRollbackTransaction,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue,
  type OrcadRollbackTransaction
} from './orcad-activation-transaction'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  exec,
  launchAndGate,
  STOP_WAIT_SECONDS,
  stopOrcadSlot
} from './orcad-remote-runtime-control'
import {
  snapshotDirPath,
  readStateWritesSinceActivation,
  resolveActiveRuntimeIdentity,
  captureRollbackRescue,
  recoverActiveRuntime,
  stopFailedTargetAndRecoverActive,
  type ActiveRuntimeIdentity,
  type RollbackRescueSnapshot
} from './orcad-rollback-recovery'

export async function rollbackLocked(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl
): Promise<OrcadRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  let snapshotPresent: boolean | null = false
  if (options.record.snapshot) {
    let output: string
    try {
      output = await exec(
        options,
        probeOrcadStateSnapshotCommand(
          options.host,
          snapshotDirPath(options, options.record.snapshot.dirName)
        )
      )
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      output = ''
    }
    const presence = parseOrcadSnapshotPresence(output)
    snapshotPresent = presence === 'unverifiable' ? null : presence === 'present'
  }

  const safety = assessOrcadRollback({
    record: options.record,
    snapshotPresent,
    census: options.census,
    stateWritesSinceActivation: await readStateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }

  let activeIdentity: ActiveRuntimeIdentity | null
  try {
    activeIdentity = await resolveActiveRuntimeIdentity(options)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'orcad_rollback_active_identity_unverifiable',
      reason:
        `The active orcad identity could not be verified before stopping it: ` +
        `${error instanceof Error ? error.message : String(error)} Nothing was changed.`
    }
  }

  if (!activeIdentity) {
    return {
      outcome: 'failed',
      code: 'orcad_rollback_active_identity_unverifiable',
      reason: 'The activation record has no active runtime to recover if rollback fails.'
    }
  }

  const transactionStartedAt = now()
  let transaction: OrcadRollbackTransaction = createOrcadRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: activeIdentity.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, transactionStartedAt),
    rescueDirName: orcadRollbackRescueDirName(
      activeIdentity.version,
      transactionStartedAt.getTime()
    ),
    now: transactionStartedAt
  })
  await writeOrcadActivationTransaction(options, transaction)
  lock.retainOnError()

  const stopped = await stopOrcadSlot(options, activeIdentity.remoteDir)
  if (!orcadStopFreedTheHost(stopped)) {
    return {
      outcome: 'failed',
      code: 'orcad_rollback_stop_incomplete',
      reason:
        `orcad ${options.record.active} did not exit within ${STOP_WAIT_SECONDS}s of its graceful stop request ` +
        `(${stopped}). Nothing was restored — the store is untouched and the host is still ` +
        'serving the version you tried to leave.'
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeOrcadActivationTransaction(options, transaction)

  let rescue: RollbackRescueSnapshot | null
  try {
    rescue = await captureRollbackRescue(options, transaction.rescue.dirName)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    rescue = null
  }
  if (!rescue) {
    const recovery = await recoverActiveRuntime(options, activeIdentity)
    if (!recovery.recovered) {
      lock.retain()
    }
    return {
      outcome: 'failed',
      code: 'orcad_rollback_rescue_snapshot_failed',
      reason:
        'The rollback was cancelled because the current state could not be preserved in a ' +
        `pre-rollback rescue snapshot; the data root was not replaced. ${recovery.reason}.`
    }
  }
  transaction = withOrcadRollbackRescue(transaction, rescue.state, now())
  await writeOrcadActivationTransaction(options, transaction)

  // Why between stop and start: the store must be replaced while no orcad holds it, and
  // before the older build gets a chance to migrate the newer build's state.
  lock.retainOnError()
  let restoreOutput: string
  try {
    restoreOutput = await exec(
      options,
      restoreOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        // Guarded by `assessOrcadRollback`: `unsafe` covers a missing snapshot.
        snapshotDirPath(options, options.record.snapshot?.dirName ?? '')
      )
    )
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    restoreOutput = 'FAILED'
  }
  const restored = parseOrcadSnapshotRestore(restoreOutput)
  if (restored !== 'restored') {
    const recovery = await recoverActiveRuntime(options, activeIdentity, rescue)
    if (!recovery.recovered) {
      lock.retain()
    }
    return {
      outcome: 'failed',
      code: 'orcad_rollback_restore_failed',
      reason:
        `The pre-activation snapshot could not be restored (${restored}). ` +
        `The pre-rollback state was preserved in a rescue snapshot; ${recovery.reason}.`
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeOrcadActivationTransaction(options, transaction)

  const targetDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    safety.target,
    options.host.pathFlavor
  )
  const targetIdentity: ActiveRuntimeIdentity = {
    version: safety.target,
    remoteDir: targetDir,
    buildHash: options.targetBuildHash,
    ...(options.nodePath ? { nodePath: options.nodePath } : {})
  }
  let target: Awaited<ReturnType<typeof launchAndGate>>
  try {
    target = await launchAndGate(options, targetIdentity)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    const recovery = await stopFailedTargetAndRecoverActive(
      options,
      lock,
      targetIdentity,
      activeIdentity,
      rescue
    )
    return {
      outcome: 'failed',
      code: recovery.code ?? 'orcad_rollback_target_launch_failed',
      reason:
        `The rollback target ${safety.target} failed while starting or proving readiness: ` +
        `${error instanceof Error ? error.message : String(error)} ${recovery.reason}. Its ` +
        `stderr is at ${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
    }
  }
  const verdict = target.verdict
  if (verdict.decision === 'reject') {
    const recovery = await stopFailedTargetAndRecoverActive(
      options,
      lock,
      targetIdentity,
      activeIdentity,
      rescue
    )
    return {
      outcome: 'failed',
      code: recovery.code ?? verdict.code,
      reason:
        `The rollback target ${safety.target} did not come up healthy: ${verdict.reason} ` +
        `${recovery.reason}. Its stderr is at ` +
        `${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
    }
  }

  // Why the record is written last: until the target is proven serving, `active` still names
  // the version an operator would need to bring back, and `previous` still names this target.
  transaction = withOrcadRollbackPhase(transaction, 'target-ready', now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict,
    readiness: target.readiness ?? neverReadiness()
  }
}

function neverReadiness(): never {
  throw new Error('Accepted orcad rollback without readiness')
}
