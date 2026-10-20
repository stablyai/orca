/**
 * The locked half of a deploy: stop, snapshot, start and commit, journaled at every step.
 *
 * The journal is durable before the first mutation, so a crash at any point leaves enough on
 * the host for `recoverInterruptedOrcadActivation` to finish or undo it. A run that ends with
 * the host provably back on one slot drops the fence; one that cannot prove it keeps it.
 */
import { orcadRemoteBaseDir } from '../managed-server/install/orcad-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { OrcadDeployOptions, OrcadDeployResult } from './orcad-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import {
  withActivatedVersion,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from '../managed-server/activation/orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record-store'
import { launchAndJudgeOrcadSlot } from './orcad-candidate-launch-verdict'
import { planOrcadUpdate } from './orcad-update-plan'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from './orcad-daemon-protocol-crossing'
import { ORCAD_LOG_FILENAME } from '../managed-server/install/orcad-remote-host-support'
import { orcadSnapshotFailureReason } from '../managed-server/host-state/orcad-state-snapshot-space'
import {
  ORCAD_SNAPSHOT_SPACE_INSUFFICIENT_CODE,
  orcadSnapshotRoomRefusal,
  orcadSnapshotsRoot
} from './orcad-snapshot-room'
import {
  captureOrcadStateSnapshotCommand,
  orcadSnapshotDirName,
  parseOrcadSnapshotCapture
} from '../managed-server/host-state/orcad-state-snapshot'
import { joinRemotePath } from './ssh-remote-platform'
import { computeLocalOrcadBuildHash } from './orcad-local-build-hash'
import { preflightInstalledOrcad } from '../managed-server/install/orcad-remote-preflight'
import type { OrcadActivationLockControl } from '../managed-server/activation/orcad-activation-lock'
import type { OrcadActivateTransaction } from '../managed-server/activation/orcad-activation-transaction'
import {
  createOrcadActivationTransaction,
  withOrcadActivationCandidateReady,
  withOrcadActivationIncumbentStopped,
  withOrcadActivationSnapshot
} from '../managed-server/activation/orcad-activation-transaction-transitions'
import { writeOrcadActivationTransaction } from '../managed-server/activation/orcad-activation-transaction-store'
import {
  execOrcadRemoteOr,
  withoutAbortSignal
} from '../managed-server/install/orcad-remote-runtime-control'
import { execOrcadStateMutationOr } from '../managed-server/host-state/orcad-state-mutation-exec'
import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'
import {
  orcadSlotDir,
  resolveOrcadSlotIdentity,
  type OrcadSlotIdentity
} from './orcad-recovery-slot'
import { orcadSnapshotPath } from './orcad-incumbent-recovery'
import {
  restartAfterSnapshotFailure,
  restoreAfterRejectedCandidate,
  stopTransactionIncumbent
} from './orcad-transaction-incumbent'
import { withOrcadLogTail } from '../managed-server/install/orcad-remote-log-tail'
import { orcadCandidateLaunchFailureCode } from '../orcad/orcad-host-unavailable'
import { errorMessage } from '../../shared/error-message'

type Outcome = Extract<OrcadDeployResult, { outcome: 'installed-not-activated' }>

/** The caller's `admitRecord` refused the record found under the fence; nothing was touched. */
export const ORCAD_ACTIVATION_POLICY_REFUSED_CODE = 'orcad_activation_policy_refused'

const UNVERIFIABLE_CENSUS: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

function countedLockedRecord(options: OrcadDeployOptions, record: OrcadActivationRecord): boolean {
  const counted = options.censusRecord
  return (
    !counted || (counted.active === record.active && counted.activatedAt === record.activatedAt)
  )
}

/** A census counted against another incumbent says nothing about this one's terminals. */
function censusForLockedRecord(
  options: OrcadDeployOptions,
  record: OrcadActivationRecord
): OrcadTerminalCensus {
  return countedLockedRecord(options, record) ? options.census : UNVERIFIABLE_CENSUS
}

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
  const record = await readOrcadActivationRecord(options)
  const plan = planOrcadUpdate({
    record,
    candidateVersion: fullVersion,
    census: censusForLockedRecord(options, record),
    candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
    ...(options.force !== undefined ? { force: options.force } : {})
  })
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  const refusal = options.admitRecord?.(record, fullVersion)
  if (refusal) {
    return notActivated(ORCAD_ACTIVATION_POLICY_REFUSED_CODE, refusal)
  }
  if (plan.action === 'defer') {
    return notActivated(plan.code, plan.reason)
  }

  try {
    await preflightInstalledOrcad({
      ...options,
      remoteInstallDir: remoteDir,
      fullVersion
    })
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
      await execOrcadRemoteOr(
        options,
        initialOrcadActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    if (admission.decision === 'defer') {
      return notActivated(admission.code, admission.reason)
    }
  }

  // Before the recount: a slow scan must not outdate the census that admits the stop.
  const roomless = await orcadSnapshotRoomRefusal(options, record, fullVersion)
  if (roomless) {
    return notActivated(ORCAD_SNAPSHOT_SPACE_INSUFFICIENT_CODE, roomless)
  }

  // Last check before anything stops: the census above may predate a long upload.
  if (incumbent) {
    const recount = planOrcadUpdate({
      record,
      candidateVersion: fullVersion,
      census: countedLockedRecord(options, record)
        ? await options.recountCensus().catch(() => UNVERIFIABLE_CENSUS)
        : UNVERIFIABLE_CENSUS,
      candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
      ...(options.force !== undefined ? { force: options.force } : {})
    })
    if (recount.action === 'defer') {
      return notActivated(recount.code, recount.reason)
    }
  }

  const startedAt = now()
  let transaction: OrcadActivateTransaction = createOrcadActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion: fullVersion,
    appVersion: options.appVersion,
    recordBefore: record,
    snapshotDirName: orcadSnapshotDirName(fullVersion, startedAt.getTime()),
    now: startedAt
  })
  await writeOrcadActivationTransaction(options, transaction)
  lock.retainOnError()
  // Past the first mutation a cancel would strand a stopped host, so the run finishes or rolls back.
  options = withoutAbortSignal(options)

  const unstopped = incumbent ? await stopTransactionIncumbent(options, incumbent, lock) : null
  if (unstopped) {
    return notActivated(
      'orcad_outgoing_stop_incomplete',
      `${unstopped} No snapshot was taken and the candidate was not started. Orca requires ` +
        'matching runtime readiness before signaling an incumbent and confirmed exit before ' +
        'snapshotting.'
    )
  }
  transaction = withOrcadActivationIncumbentStopped(transaction, now())
  await writeOrcadActivationTransaction(options, transaction)

  // A live SQLite WAL is not a backup boundary, so the snapshot waits for confirmed exit.
  const snapshotDir = orcadSnapshotPath(options, transaction.snapshot.dirName)
  const captureOutput = await execOrcadStateMutationOr(
    options,
    captureOrcadStateSnapshotCommand(
      options.host,
      options.userDataDir,
      snapshotDir,
      orcadRemoteBaseDir(options.host, options.remoteHome),
      {
        snapshotsRoot: orcadSnapshotsRoot(options),
        keep: [transaction.snapshot.dirName, ...(record.snapshot ? [record.snapshot.dirName] : [])]
      }
    ),
    'FAILED'
  )
  const capture = parseOrcadSnapshotCapture(captureOutput)
  if (capture === 'failed') {
    const reason = orcadSnapshotFailureReason(captureOutput)
    const restarted = incumbent
      ? ` The incumbent was stopped before snapshotting; ${await restartAfterSnapshotFailure(options, incumbent, lock)}`
      : ''
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}` +
        `${reason ? `: ${reason}` : ''}. Orca's persisted state carries no schema version, so ` +
        'without a snapshot a rollback has no way back. Refusing to activate. Fix what stops ' +
        `the copy (often a full disk or quota on ${orcadRemoteBaseDir(options.host, options.remoteHome)}), ` +
        `then reconnect.${restarted}`
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

  const { verdict, launchError } = await launchAndJudgeOrcadSlot(options, {
    remoteInstallDir: remoteDir,
    fullVersion,
    buildHash: computeLocalOrcadBuildHash(options.localOrcadDir)
  })
  if (verdict.decision === 'reject') {
    const [code, reason] =
      launchError === undefined
        ? [verdict.code, verdict.reason]
        : [
            orcadCandidateLaunchFailureCode(launchError),
            `The candidate failed while starting: ${errorMessage(launchError)}`
          ]
    const restored = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: orcadSlotDir(options, transaction.candidateVersion),
      launchedVersion: transaction.candidateVersion,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: transaction.snapshot
    })
    const located =
      `${reason} Candidate stderr is at ` +
      `${joinRemotePath(options.host, remoteDir, ORCAD_LOG_FILENAME)}. ${restored}`
    return notActivated(code, await withOrcadLogTail(options, remoteDir, located))
  }

  const recordAfter = withActivatedVersion(record, fullVersion, snapshot, now(), options.appVersion)
  transaction = withOrcadActivationCandidateReady(transaction, recordAfter, now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, recordAfter)
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}
