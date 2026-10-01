/**
 * The locked half of a deploy: stop, snapshot, start and commit, journaled at every step.
 *
 * The journal is durable before the first mutation, so a crash at any point leaves enough on
 * the host for `recoverInterruptedOrcadActivation` to finish or undo it. A run that ends with
 * the host provably back on one slot drops the fence; one that cannot prove it keeps it.
 */
import { randomUUID } from 'node:crypto'
import type { OrcadDeployOptions, OrcadDeployResult } from './orcad-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { withActivatedVersion, type OrcadStateSnapshot } from './orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { evaluateOrcadActivation } from './orcad-activation-gate'
import { planOrcadUpdate } from './orcad-update-plan'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from './orcad-daemon-protocol-crossing'
import { ORCAD_LOG_FILENAME, type OrcadReadinessParse } from './orcad-remote-launch'
import {
  captureOrcadStateSnapshotCommand,
  orcadSnapshotDirName,
  parseOrcadSnapshotCapture
} from './orcad-state-snapshot'
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { joinRemotePath } from './ssh-remote-platform'
import { computeLocalOrcadBuildHash } from './orcad-local-build-hash'
import { preflightInstalledOrcad } from './orcad-remote-preflight'
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import type { OrcadActivateTransaction } from './orcad-activation-transaction'
import {
  createOrcadActivationTransaction,
  withOrcadActivationCandidateReady,
  withOrcadActivationIncumbentStopped,
  withOrcadActivationSnapshot
} from './orcad-activation-transaction-transitions'
import {
  readOrcadActivationTransaction,
  writeOrcadActivationTransaction
} from './orcad-activation-transaction-store'
import {
  execOrcadRemote,
  launchOrcadAndAwaitReadiness,
  withoutAbortSignal
} from './orcad-remote-runtime-control'
import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'
import {
  launchOrcadSlot,
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  stopOrcadSlot,
  ORCAD_SLOT_STOP_WAIT_SECONDS,
  type OrcadSlotIdentity
} from './orcad-recovery-slot'
import { orcadSnapshotPath, recoverOrcadIncumbent } from './orcad-incumbent-recovery'

type Outcome = Extract<OrcadDeployResult, { outcome: 'installed-not-activated' }>

export async function activateInstalledOrcad(
  options: OrcadDeployOptions & { localOrcadDir: string },
  fullVersion: string,
  remoteDir: string,
  lock: OrcadActivationLockControl
): Promise<OrcadDeployResult> {
  const now = options.now ?? ((): Date => new Date())
  const notActivated = (code: string, reason: string): Outcome => ({
    outcome: 'installed-not-activated',
    fullVersion,
    code,
    reason
  })
  if (await readOrcadActivationTransaction(options)) {
    // Holding the lock proves its writer is gone, but undoing its work needs a fresh census.
    lock.retain()
    return notActivated(
      'orcad_activation_recovery_required',
      'An earlier activation on this host was interrupted. Recover it before deploying again.'
    )
  }
  const record = await readOrcadActivationRecord(options)
  const plan = planOrcadUpdate({
    record,
    candidateVersion: fullVersion,
    census: options.census,
    candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
    ...(options.force !== undefined ? { force: options.force } : {})
  })
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  if (plan.action === 'defer') {
    return notActivated(plan.code, plan.reason)
  }

  try {
    await preflightInstalledOrcad({ ...options, remoteInstallDir: remoteDir, fullVersion })
  } catch (error) {
    options.signal?.throwIfAborted()
    return notActivated(
      'orcad_candidate_preflight_failed',
      `Candidate profile preflight failed; the incumbent was not stopped: ${errorMessage(error)}`
    )
  }

  let incumbent: OrcadSlotIdentity | null = null
  if (record.active) {
    try {
      incumbent = await resolveOrcadSlotIdentity(options, record.active)
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return notActivated(
        'orcad_incumbent_identity_unverifiable',
        `The active orcad ${record.active} build identity could not be verified before ` +
          `stopping it: ${errorMessage(error)} Nothing was stopped.`
      )
    }
  } else {
    const admission = parseInitialOrcadActivationAdmission(
      await execOrcadRemote(
        options,
        initialOrcadActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      ).catch((error: unknown) => {
        if (isUnconfirmedSshCommandTermination(error)) {
          throw error
        }
        return ''
      })
    )
    if (admission.decision === 'defer') {
      return notActivated(admission.code, admission.reason)
    }
  }

  const startedAt = now()
  let transaction: OrcadActivateTransaction = createOrcadActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion: fullVersion,
    recordBefore: record,
    snapshotDirName: orcadSnapshotDirName(fullVersion, startedAt.getTime()),
    now: startedAt
  })
  await writeOrcadActivationTransaction(options, transaction)
  lock.retainOnError()

  if (incumbent) {
    const stopped = await stopOrcadSlot(options, incumbent.remoteDir, false)
    if (!orcadStopFreedTheHost(stopped)) {
      // Only a delivered SIGTERM can still change the host; otherwise nothing happened.
      if (stopped === 'still-running') {
        lock.retain()
      }
      return notActivated(
        'orcad_outgoing_stop_incomplete',
        `Could not verify that orcad ${incumbent.version} exited within ` +
          `${ORCAD_SLOT_STOP_WAIT_SECONDS}s (${stopped}). No snapshot was taken and the ` +
          'candidate was not started. Orca requires matching runtime readiness before ' +
          'signaling an incumbent and confirmed exit before snapshotting.'
      )
    }
  }
  transaction = withOrcadActivationIncumbentStopped(transaction, now())
  await writeOrcadActivationTransaction(options, transaction)

  // A live SQLite WAL is not a backup boundary, so the snapshot waits for confirmed exit.
  const snapshotDir = orcadSnapshotPath(options, transaction.snapshot.dirName)
  const capture = parseOrcadSnapshotCapture(
    await execOrcadRemote(
      options,
      captureOrcadStateSnapshotCommand(options.host, options.userDataDir, snapshotDir)
    ).catch((error: unknown) => {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return 'FAILED'
    })
  )
  if (capture === 'failed') {
    const restarted = incumbent
      ? ` The incumbent was stopped before snapshotting; ${await restartAfterSnapshotFailure(options, incumbent, lock)}`
      : ''
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}. Orca's ` +
        'persisted state carries no schema version, so without a snapshot a rollback has no ' +
        `way back. Refusing to activate.${restarted}`
    )
  }
  const snapshot: OrcadStateSnapshot | null =
    capture === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: fullVersion,
          readableByVersion: record.active,
          takenAt: startedAt.toISOString()
        }
      : null
  transaction = withOrcadActivationSnapshot(transaction, capture, now())
  await writeOrcadActivationTransaction(options, transaction)

  let parsed: OrcadReadinessParse | null = null
  let launchError: unknown
  try {
    parsed = await launchOrcadAndAwaitReadiness(options, {
      remoteInstallDir: remoteDir,
      nodePath: options.nodePath,
      fullVersion,
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
    buildHash: computeLocalOrcadBuildHash(options.localOrcadDir),
    fullVersion
  })
  if (verdict.decision === 'reject') {
    const [code, reason] =
      launchError === undefined
        ? [verdict.code, verdict.reason]
        : [
            'orcad_candidate_launch_failed',
            `The candidate failed while starting: ${errorMessage(launchError)}`
          ]
    const restored = await restoreAfterRejectedCandidate(options, transaction, incumbent, lock)
    return notActivated(
      code,
      `${reason} Candidate stderr is at ` +
        `${joinRemotePath(options.host, remoteDir, ORCAD_LOG_FILENAME)}. ${restored}`
    )
  }

  const recordAfter = withActivatedVersion(record, fullVersion, snapshot, now())
  transaction = withOrcadActivationCandidateReady(transaction, recordAfter, now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, recordAfter)
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}

async function restartAfterSnapshotFailure(
  options: OrcadDeployOptions,
  incumbent: OrcadSlotIdentity,
  lock: OrcadActivationLockControl
): Promise<string> {
  try {
    await launchOrcadSlot(withoutAbortSignal(options), incumbent)
    lock.recovered()
    return `orcad ${incumbent.version} was restarted and is serving again.`
  } catch (error) {
    lock.retain()
    return `restarting orcad ${incumbent.version} failed: ${errorMessage(error)} This host requires recovery.`
  }
}

/** Stop the candidate this run launched, then put the incumbent back only on safe state. */
async function restoreAfterRejectedCandidate(
  options: OrcadDeployOptions,
  transaction: OrcadActivateTransaction,
  incumbent: OrcadSlotIdentity | null,
  lock: OrcadActivationLockControl
): Promise<string> {
  const recoveryOptions = withoutAbortSignal(options)
  try {
    const candidateDir = orcadSlotDir(options, transaction.candidateVersion)
    const stopped = await stopOrcadSlot(recoveryOptions, candidateDir, true)
    if (!orcadStopFreedTheHost(stopped)) {
      lock.retain()
      return `The candidate itself did not stop (${stopped}); the host may still be serving the rejected build.`
    }
    const recovery = await recoverOrcadIncumbent(recoveryOptions, {
      transactionStartedAt: transaction.startedAt,
      launchedVersion: transaction.candidateVersion,
      incumbent,
      restoreState: transaction.snapshot,
      slotsProvenExited: true
    })
    if (recovery.outcome === 'refused') {
      lock.retain()
      return recovery.reason
    }
    return incumbent
      ? `orcad ${incumbent.version} was restarted and is serving again.`
      : 'No previous version was active, so this host is now serving nothing.'
  } catch (error) {
    lock.retain()
    return `Restoring the previous version failed: ${errorMessage(error)} This host requires recovery.`
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
