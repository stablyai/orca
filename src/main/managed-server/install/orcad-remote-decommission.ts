// Journal instance-bound stop under the activation fence; refuse live/unknown terminal census and deactivate only after proven exit.
import { randomUUID } from 'node:crypto'
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from '../activation/orcad-activation-record-store'
import { sameOrcadActivationRecord } from '../activation/orcad-activation-transaction'
import { writeOrcadActivationTransaction } from '../activation/orcad-activation-transaction-store'
import { withOrcadActivationLock } from '../activation/orcad-activation-lock'
import { orcadActivationFenceRefusal } from '../activation/orcad-activation-fence-hold'
import {
  committedOrcadDecommissionRecord,
  createOrcadDecommissionTransaction,
  withOrcadDecommissionProcessExited,
  withOrcadDecommissionStopDispatched
} from '../lifecycle/orcad-decommission-transaction'
import { readRemoteOrcadManagedStopTarget } from '../lifecycle/orcad-managed-remote-stop'
import { settleOrcadDecommissionStop } from '../lifecycle/orcad-decommission-stop'
import type { OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import type { OrcadDecommissionResult } from '../../../shared/orcad-decommission'
import type { OrcadTerminalCensus } from '../../../shared/orcad-terminal-census'

type OrcadDecommissionOptions = OrcadSlotOptions & {
  /** Refuse if the host record changed since caller review. */
  record: OrcadActivationRecord
  /** Fresh census must prove no live or uncounted terminals. */
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
        // Idle daemon retirement is best-effort; busy daemons retain their terminals.
        retireIdleDaemon: true as const
      }
      // Journal exact stop intent before dispatch so recovery can settle the same request.
      transaction = withOrcadDecommissionStopDispatched(transaction, request, now())
      await writeOrcadActivationTransaction(options, transaction)

      const settlement = await settleOrcadDecommissionStop(options, request)
      if (settlement.state === 'withdrawn') {
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
