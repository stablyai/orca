/** Journal durably before mutation so interrupted deploys can finish or recover. Release the fence only once the host is provably settled on one slot. */
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
import {
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../shared/orcad-terminal-census'
import { runFencedStop } from './orcad-fenced-stop'
import {
  censusNeedsHostDaemonProtocols,
  CURRENT_ORCAD_DAEMON_PROTOCOL
} from './orcad-daemon-protocol-crossing'
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
import { preflightOrcadCandidate } from './orcad-candidate-preflight'
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

export const ORCAD_ACTIVATION_POLICY_REFUSED_CODE = 'orcad_activation_policy_refused'

function countedLockedRecord(options: OrcadDeployOptions, record: OrcadActivationRecord): boolean {
  const counted = options.censusRecord
  return (
    !counted || (counted.active === record.active && counted.activatedAt === record.activatedAt)
  )
}

/** A census of another incumbent cannot authorize stopping this one. */
function censusForLockedRecord(
  options: OrcadDeployOptions,
  record: OrcadActivationRecord
): OrcadTerminalCensus {
  return countedLockedRecord(options, record) ? options.census : UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
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
  const planFor = (
    census: OrcadTerminalCensus,
    hostDaemonProtocols?: readonly number[]
  ): ReturnType<typeof planOrcadUpdate> =>
    planOrcadUpdate({
      record,
      candidateVersion: fullVersion,
      census,
      candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
      ...(hostDaemonProtocols ? { hostDaemonProtocols } : {}),
      ...(options.force !== undefined ? { force: options.force } : {})
    })
  const census = censusForLockedRecord(options, record)
  let plan = planFor(census)
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  const refusal = options.admitRecord?.(record, fullVersion)
  if (refusal) {
    return notActivated(ORCAD_ACTIVATION_POLICY_REFUSED_CODE, refusal)
  }
  // Hosts predating the census protocol set cannot name mixed generations; the candidate can.
  const asksCandidate = censusNeedsHostDaemonProtocols(census)
  if (
    plan.action === 'defer' &&
    !(asksCandidate && plan.code === 'orcad_update_daemon_protocol_unverifiable')
  ) {
    return notActivated(plan.code, plan.reason)
  }
  const preflight = await preflightOrcadCandidate(
    { ...options, remoteInstallDir: remoteDir, fullVersion },
    asksCandidate
  )
  if ('failure' in preflight) {
    return notActivated('orcad_candidate_preflight_failed', preflight.failure)
  }
  const { hostDaemonProtocols } = preflight
  plan = planFor(census, hostDaemonProtocols)
  if (plan.action === 'defer') {
    return notActivated(plan.code, plan.reason)
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

  // Scan snapshot room before recount so slow scans cannot outdate stop admission.
  const roomless = await orcadSnapshotRoomRefusal(options, record, fullVersion)
  if (roomless) {
    return notActivated(ORCAD_SNAPSHOT_SPACE_INSUFFICIENT_CODE, roomless)
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
  const beginMutating = (): void => {
    lock.retainOnError()
    // After mutation starts, cancellation would strand a stopped host; finish or roll back.
    options = withoutAbortSignal(options)
  }
  if (incumbent) {
    // Recount immediately before stop; the initial census may predate a long upload.
    const fenced = await runFencedStop({
      recountCensus: () =>
        countedLockedRecord(options, record)
          ? options.recountCensus()
          : Promise.reject(new Error('not the incumbent this update counted')),
      releaseIncumbentAdmission: options.releaseIncumbentAdmission,
      now: () => now().getTime(),
      refuse: (recounted) => {
        const plan = planFor(recounted, hostDaemonProtocols)
        return plan.action === 'defer' ? notActivated(plan.code, plan.reason) : null
      },
      prepare: () => writeOrcadActivationTransaction(options, transaction),
      stale: () =>
        notActivated(
          'orcad_update_terminal_census_unavailable',
          'The terminal count went stale before the current server could be stopped, so nothing ' +
            'was stopped. Orca will try the update again.'
        ),
      stop: () => {
        beginMutating()
        return stopTransactionIncumbent(options, incumbent, lock)
      },
      stopMayHaveBeenSent: (unstopped) => unstopped === null || unstopped.stopMayBeUnderway
    })
    if ('refused' in fenced) {
      return fenced.refused
    }
    if (fenced.stopped) {
      return notActivated(
        'orcad_outgoing_stop_incomplete',
        `${fenced.stopped.reason} No snapshot was taken and the candidate was not started. Orca ` +
          'requires matching runtime readiness before signaling an incumbent and confirmed exit ' +
          'before snapshotting.'
      )
    }
  } else {
    await writeOrcadActivationTransaction(options, transaction)
    beginMutating()
  }
  transaction = withOrcadActivationIncumbentStopped(transaction, now())
  await writeOrcadActivationTransaction(options, transaction)

  // Wait for confirmed exit before snapshotting; a live SQLite WAL is not a backup boundary.
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
