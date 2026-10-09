/**
 * Decommissioning a managed orcad: stop its active instance and record that nothing serves.
 *
 * Runs under the activation fence and journal, so an interrupted decommission recovers like an
 * activation does. It refuses while the terminal census says terminals are live or cannot be
 * counted, and it never signals: the instance-bound request reaches only the orcad it names.
 * Only proven exit deactivates the record; anything less withdraws the request or keeps the
 * fence. Windows runs the same steps: the request is a staged file and exit proof is orcad's own.
 */
import { randomUUID } from 'node:crypto'
import type { OrcadActivationRecord } from './orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { sameOrcadActivationRecord } from './orcad-activation-transaction'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { withOrcadActivationLock } from './orcad-activation-lock'
import { orcadActivationFenceRefusal } from './orcad-activation-fence-hold'
import {
  committedOrcadDecommissionRecord,
  createOrcadDecommissionTransaction,
  withOrcadDecommissionProcessExited,
  withOrcadDecommissionStopDispatched
} from './orcad-decommission-transaction'
import { readRemoteOrcadManagedStopTarget } from './orcad-managed-remote-stop'
import { settleOrcadDecommissionStop } from './orcad-decommission-stop'
import type { OrcadSlotOptions } from './orcad-recovery-slot'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'

export type OrcadDecommissionOptions = OrcadSlotOptions & {
  /** The record the caller reviewed; a changed host record refuses rather than guessing. */
  record: OrcadActivationRecord
  /** Taken by the caller just before; any live or uncounted terminal refuses. */
  census: OrcadTerminalCensus
  now?: () => Date
}

type Refusal = Extract<OrcadDecommissionResult, { outcome: 'refused' }>

function refuse(verdict: Refusal['verdict'], code: string, reason: string): Refusal {
  return { outcome: 'refused', verdict, code, reason }
}

function censusRefusal(census: OrcadTerminalCensus): Refusal | null {
  if (census.liveSessions === null) {
    return refuse(
      'unverifiable',
      'orcad_decommission_census_unavailable',
      'The terminal daemon did not answer a session count, so decommissioning could end ' +
        'running work. Retry when the host answers.'
    )
  }
  if (census.liveSessions > 0) {
    return refuse(
      'live',
      'orcad_decommission_terminals_running',
      `${census.liveSessions} terminal${census.liveSessions === 1 ? ' is' : 's are'} still ` +
        'running on this host. Close them before decommissioning the server.'
    )
  }
  return null
}

export async function decommissionRemoteOrcad(
  options: OrcadDecommissionOptions
): Promise<OrcadDecommissionResult> {
  const now = options.now ?? ((): Date => new Date())
  return withOrcadActivationLock(
    options,
    async (lock) => {
      const record = await readOrcadActivationRecord(options)
      if (!sameOrcadActivationRecord(record, options.record)) {
        return refuse(
          'unverifiable',
          'orcad_decommission_record_changed',
          'The host activation record changed since it was reviewed. Refresh and try again.'
        )
      }
      const activeVersion = record.active
      if (!activeVersion) {
        return refuse(
          'unverifiable',
          'orcad_decommission_nothing_active',
          'No orcad version is active on this host, so there is nothing to decommission.'
        )
      }
      const census = censusRefusal(options.census)
      if (census) {
        return census
      }
      const target = await readRemoteOrcadManagedStopTarget(options, activeVersion)
      if (target.state === 'refused') {
        return refuse(target.verdict, target.code, target.reason)
      }

      let transaction = createOrcadDecommissionTransaction({
        transactionId: randomUUID(),
        recordBefore: { ...record, active: activeVersion },
        now: now()
      })
      await writeOrcadActivationTransaction(options, transaction)
      lock.retainOnError()
      const request = {
        schemaVersion: 1 as const,
        transactionId: transaction.transactionId,
        ...target.context,
        // Best effort: an idle daemon goes with orcad, a busy one keeps its terminals.
        retireIdleDaemon: true as const
      }
      // Durable before it can reach the host, so recovery can settle exactly this request.
      transaction = withOrcadDecommissionStopDispatched(transaction, request, now())
      await writeOrcadActivationTransaction(options, transaction)

      const settlement = await settleOrcadDecommissionStop(options, request)
      if (settlement.state === 'withdrawn') {
        // orcad never acted on it and keeps serving; the record never changed.
        return refuse(settlement.verdict, 'orcad_decommission_stop_withdrawn', settlement.reason)
      }
      if (settlement.state === 'unsettled') {
        lock.retain()
        return refuse(settlement.verdict, 'orcad_decommission_stop_unsettled', settlement.reason)
      }
      transaction = withOrcadDecommissionProcessExited(transaction, now())
      await writeOrcadActivationTransaction(options, transaction)
      await writeOrcadActivationRecord(options, committedOrcadDecommissionRecord(transaction))
      return {
        outcome: 'decommissioned',
        version: activeVersion,
        retirement: settlement.retirement
      }
    },
    async () => {
      const refusal = await orcadActivationFenceRefusal(options, 'stop')
      return refuse('unverifiable', refusal.code, refusal.reason)
    }
  )
}
