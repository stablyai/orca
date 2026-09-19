import { randomUUID } from 'node:crypto'
import type { SshConnection } from './ssh-connection'
import {
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion,
  type OrcadActivationRecord
} from './orcad-activation-record'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { withOrcadActivationLock } from './orcad-activation-lock'
import {
  parseOrcadStopOutcome,
  stopOrcadCommand,
  type OrcadStopOutcome
} from './orcad-remote-process-control'
import { execCommand } from './ssh-relay-deploy-helpers'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import {
  createOrcadDecommissionTransaction,
  sameOrcadActivationRecord,
  withOrcadDecommissionPhase,
  type OrcadDecommissionTransaction
} from './orcad-activation-transaction'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import type { OrcadManagedStopAuthority } from '../../shared/orcad-managed-stop-authority'
import type { readRemoteOrcadManagedStopIdentity } from './orcad-decommission-client'
import type { OrcadManagedDecommissionResult } from '../../shared/orcad-managed-decommission'
import { stopManagedRemoteOrcad } from './orcad-managed-remote-stop'

const STOP_WAIT_SECONDS = 20

export type OrcadRemoteStopResult =
  | { outcome: 'stopped'; activeVersion: string; alreadyDeactivated: boolean }
  | {
      outcome: 'refused'
      verdict: 'live' | 'unverifiable'
      code: string
      reason: string
    }

export type RemoteStopOptions = {
  assertDecommissionAllowed?: () => void
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  record: OrcadActivationRecord
  requestDecommission: (
    activeVersion: string,
    transactionId: string
  ) => Promise<OrcadDecommissionResult>
  managedStop?: {
    runtimeId: string
    readIdentity: (version: string) => ReturnType<typeof readRemoteOrcadManagedStopIdentity>
    requestDecommission: (
      version: string,
      authority: OrcadManagedStopAuthority
    ) => Promise<OrcadManagedDecommissionResult>
  }
  now?: () => Date
  signal?: AbortSignal
}

export async function stopRemoteOrcad(options: RemoteStopOptions): Promise<OrcadRemoteStopResult> {
  return withOrcadActivationLock(options, async (lock) => {
    let record = await readOrcadActivationRecord(options)
    if (serializeOrcadActivationRecord(record) !== serializeOrcadActivationRecord(options.record)) {
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_stop_record_changed',
        reason:
          'The host activation record changed while this stop was waiting. Refresh the server status and try again.'
      }
    }
    if (options.managedStop) {
      return stopManagedRemoteOrcad(options, record, lock)
    }
    if (!record.active) {
      if (record.previous) {
        return {
          outcome: 'stopped',
          activeVersion: record.previous,
          alreadyDeactivated: true
        }
      }
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_stop_active_unknown',
        reason: 'The host does not identify an active or previously deactivated orcad slot.'
      }
    }
    const activeVersion = record.active
    const now = options.now ?? ((): Date => new Date())

    if (record.decommissioning && record.decommissioning.version !== activeVersion) {
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_stop_decommission_record_mismatch',
        reason: 'The host decommission marker does not match the active orcad slot.'
      }
    }

    // The RPC can permanently fence remote admission before its response or marker write.
    lock.retainOnError()
    const transactionStartedAt = now()
    let transaction: OrcadDecommissionTransaction
    if (!record.decommissioning) {
      const acceptedRecord = withDecommissioningVersion(record, transactionStartedAt)
      transaction = createOrcadDecommissionTransaction({
        transactionId: randomUUID(),
        activeVersion,
        recordBefore: record,
        acceptedRecord,
        recordAfter: withDeactivatedVersion(acceptedRecord),
        now: transactionStartedAt
      })
      await writeOrcadActivationTransaction(options, transaction)
      options.assertDecommissionAllowed?.()
      const decommission = await options.requestDecommission(
        activeVersion,
        transaction.transactionId
      )
      if (decommission.outcome === 'refused') {
        if (decommission.verdict === 'unverifiable' || decommission.terminalAdmission !== 'open') {
          lock.retain()
        }
        return decommission
      }
      if (decommission.transactionId && decommission.transactionId !== transaction.transactionId) {
        lock.retain()
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'orcad_decommission_receipt_mismatch',
          reason: 'The host acknowledged a different managed-stop transaction.'
        }
      }
      const currentRecord = await readOrcadActivationRecord(options)
      if (sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
        await writeOrcadActivationRecord(options, transaction.acceptedRecord)
      } else if (!sameOrcadActivationRecord(currentRecord, transaction.acceptedRecord)) {
        lock.retain()
        return {
          outcome: 'refused',
          verdict: 'unverifiable',
          code: 'orcad_decommission_record_changed',
          reason: 'The host activation record changed during decommission acceptance.'
        }
      }
      record = transaction.acceptedRecord
      transaction = withOrcadDecommissionPhase(transaction, 'admission-fenced', now())
      await writeOrcadActivationTransaction(options, transaction)
    } else {
      transaction = createOrcadDecommissionTransaction({
        transactionId: randomUUID(),
        activeVersion,
        recordBefore: record,
        acceptedRecord: record,
        recordAfter: withDeactivatedVersion(record),
        now: transactionStartedAt
      })
      transaction = withOrcadDecommissionPhase(
        transaction,
        'admission-fenced',
        transactionStartedAt
      )
      await writeOrcadActivationTransaction(options, transaction)
    }

    const remoteInstallDir = computeRemoteInstallDir(
      ORCAD_INSTALL_MODEL,
      options.remoteHome,
      activeVersion,
      options.host.pathFlavor
    )
    options.assertDecommissionAllowed?.()
    const stopOutcome = parseOrcadStopOutcome(
      await execCommand(
        options.conn,
        stopOrcadCommand(options.host, remoteInstallDir, { waitSeconds: STOP_WAIT_SECONDS }),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal: options.signal
        }
      )
    )
    const refusal = stopRefusal(stopOutcome, activeVersion)
    if (refusal) {
      return refusal
    }
    transaction = withOrcadDecommissionPhase(transaction, 'process-exited', now())
    await writeOrcadActivationTransaction(options, transaction)
    await writeOrcadActivationRecord(options, transaction.recordAfter)
    return { outcome: 'stopped', activeVersion, alreadyDeactivated: false }
  })
}

function stopRefusal(
  outcome: OrcadStopOutcome,
  activeVersion: string
): Exclude<OrcadRemoteStopResult, { outcome: 'stopped' }> | null {
  if (outcome === 'stopped' || outcome === 'already-exited') {
    return null
  }
  if (outcome === 'still-running' || outcome === 'signal-failed') {
    return {
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_incomplete',
      reason:
        `orcad ${activeVersion} is still live after its graceful stop request (${outcome}). ` +
        'The managed server remains linked.'
    }
  }
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: 'orcad_stop_unverifiable',
    reason:
      `The host could not prove that orcad ${activeVersion} exited (${outcome}). ` +
      'The managed server remains linked.'
  }
}
