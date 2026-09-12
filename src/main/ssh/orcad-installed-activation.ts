import { randomUUID } from 'node:crypto'
import type { OrcadDeployOptions, OrcadDeployResult } from './orcad-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { withActivatedVersion } from './orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { evaluateOrcadActivation } from './orcad-activation-gate'
import { planOrcadUpdate } from './orcad-update-plan'
import { ORCAD_LOG_FILENAME } from './orcad-remote-launch'
import { orcadSnapshotDirName } from './orcad-state-snapshot'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import { joinRemotePath } from './ssh-remote-platform'
import { computeLocalOrcadBuildHash } from './orcad-local-build-hash'
import type { OrcadActivationLockControl } from './orcad-activation-lock'
import {
  createOrcadActivationTransaction,
  withOrcadActivationCandidateReady,
  withOrcadActivationSnapshot,
  withOrcadActivationTransactionPhase
} from './orcad-activation-transaction'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'
import {
  exec,
  launchAndAwaitReadiness,
  STOP_WAIT_SECONDS,
  withoutAbortSignal
} from './orcad-remote-runtime-control'
import {
  captureSnapshot,
  errorMessage,
  recoverIncumbentAfterSnapshotFailure,
  restoreIncumbent,
  type PreActivationSnapshot,
  type IncumbentIdentity
} from './orcad-incumbent-recovery'

export async function activateInstalledOrcad(
  options: OrcadDeployOptions,
  fullVersion: string,
  remoteDir: string,
  now: () => Date,
  lock: OrcadActivationLockControl
): Promise<OrcadDeployResult> {
  const record = await readOrcadActivationRecord(options)

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

  if (!record.active) {
    let admissionOutput = ''
    try {
      admissionOutput = await exec(
        options,
        initialOrcadActivationAdmissionCommand(options.host, options.userDataDir, remoteDir)
      )
    } catch {
      options.signal?.throwIfAborted()
    }
    const admission = parseInitialOrcadActivationAdmission(admissionOutput)
    if (admission.decision === 'defer') {
      return {
        outcome: 'installed-not-activated',
        fullVersion,
        code: admission.code,
        reason: admission.reason
      }
    }
  }

  const transactionStartedAt = now()
  let transaction = createOrcadActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion: fullVersion,
    recordBefore: record,
    snapshotDirName: orcadSnapshotDirName(fullVersion, transactionStartedAt.getTime()),
    now: transactionStartedAt
  })
  await writeOrcadActivationTransaction(options, transaction)
  lock.retainOnError()

  let snapshot: PreActivationSnapshot
  let incumbent: IncumbentIdentity | null = null
  if (record.active) {
    const outgoingDir = computeRemoteInstallDir(
      ORCAD_INSTALL_MODEL,
      options.remoteHome,
      record.active,
      options.host.pathFlavor
    )
    try {
      incumbent = {
        version: record.active,
        remoteDir: outgoingDir,
        buildHash: await readRemoteOrcadBuildHash({
          conn: options.conn,
          host: options.host,
          remoteInstallDir: outgoingDir,
          signal: options.signal
        }),
        runtimeKind: options.nodePath ? 'node' : 'bun'
      }
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return {
        outcome: 'installed-not-activated',
        fullVersion,
        code: 'orcad_incumbent_identity_unverifiable',
        reason:
          `The active orcad ${record.active} build identity could not be verified before ` +
          `stopping it: ${errorMessage(error)} The candidate remains installed but was not ` +
          'launched.'
      }
    }
    const stopped = parseOrcadStopOutcome(
      await exec(
        options,
        stopOrcadCommand(options.host, outgoingDir, {
          waitSeconds: STOP_WAIT_SECONDS
        })
      )
    )
    if (!orcadStopFreedTheHost(stopped)) {
      return {
        outcome: 'installed-not-activated',
        fullVersion,
        code: 'orcad_outgoing_stop_incomplete',
        reason:
          `orcad ${record.active} did not exit within ${STOP_WAIT_SECONDS}s of its graceful stop request ` +
          `(${stopped}). It is still holding the data root and the port, so the candidate ` +
          'cannot start. Not escalating to SIGKILL: that skips the shutdown that releases ' +
          'the instance lock, and the successor would then refuse to start.'
      }
    }
    transaction = withOrcadActivationTransactionPhase(transaction, 'incumbent-stopped', now())
    await writeOrcadActivationTransaction(options, transaction)
    // Positive process exit ends runtime ownership of the profile state. The surviving daemon
    // owns only excluded members and remains live for terminal adoption.
    try {
      snapshot = await captureSnapshot(
        options,
        fullVersion,
        record.active,
        now(),
        transaction.snapshot.dirName
      )
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return recoverIncumbentAfterSnapshotFailure(options, lock, incumbent, fullVersion, error)
    }
  } else {
    transaction = withOrcadActivationTransactionPhase(transaction, 'incumbent-stopped', now())
    await writeOrcadActivationTransaction(options, transaction)
    snapshot = await captureSnapshot(
      options,
      fullVersion,
      null,
      now(),
      transaction.snapshot.dirName
    )
  }

  transaction = withOrcadActivationSnapshot(transaction, snapshot.record, now())
  await writeOrcadActivationTransaction(options, transaction)

  let parsed: Awaited<ReturnType<typeof launchAndAwaitReadiness>>
  try {
    parsed = await launchAndAwaitReadiness(options, {
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
    const restored = await restoreIncumbent(
      withoutAbortSignal(options),
      record,
      incumbent,
      remoteDir,
      snapshot
    )
    if (!restored.recovered) {
      lock.retain()
    }
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: restored.code ?? 'orcad_candidate_launch_failed',
      reason: `The candidate failed while starting or proving readiness: ${errorMessage(error)} Candidate stderr is at ${joinRemotePath(options.host, remoteDir, ORCAD_LOG_FILENAME)}. ${restored.message}`
    }
  }
  const verdict = evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
    buildHash: computeLocalOrcadBuildHash(options.localOrcadDir),
    fullVersion,
    runtimeKind: 'bun',
    buildTarget: options.buildTarget,
    port: options.port,
    requireDaemonRuntimeIdentity: true
  })
  if (verdict.decision === 'reject') {
    const restored = await restoreIncumbent(
      withoutAbortSignal(options),
      record,
      incumbent,
      remoteDir,
      snapshot
    )
    if (!restored.recovered) {
      lock.retain()
    }
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: restored.code ?? verdict.code,
      reason:
        `${verdict.reason} Candidate stderr is at ` +
        `${joinRemotePath(options.host, remoteDir, ORCAD_LOG_FILENAME)}. ${restored.message}`
    }
  }

  const recordAfter = withActivatedVersion(record, fullVersion, snapshot.record, now())
  transaction = withOrcadActivationCandidateReady(transaction, recordAfter, now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, recordAfter)
  return {
    outcome: 'installed-and-activated',
    fullVersion,
    verdict,
    readiness: parsed.state === 'ready' ? parsed.readiness : neverReadiness()
  }
}

function neverReadiness(): never {
  throw new Error('Accepted orcad activation without readiness')
}
