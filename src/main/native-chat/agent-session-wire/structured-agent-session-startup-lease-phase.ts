// Startup's one lease phase: the restart lease check, then the recovery of every lease a crash left
// `recovering` (a provider process that outlived the crash is stopped and its death recorded), so
// each settle verdict reads that evidence. Every startup restore answers its lease bookkeeping from
// this phase and never runs the check itself; each lease is recovered once, within a budget, so a
// restore waits only on the leases of the chats it opens.

import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

// Record-only (a probe and at most a process stop each), so a few at once.
const RECOVERY_CONCURRENCY = 4
// A recovery is process probes around at most one stop (its SIGTERM grace is 5.5 s). Past this a
// probe has stopped answering: the lease stays `recovering`, unverified and never called dead, for
// the next attach or send to resolve, and startup goes on.
const RECOVERY_BUDGET_MS = 15_000

export type StructuredAgentSessionStartupLeasePhase = {
  /** Starts the phase's check once; answers, from the records, whether every lease is settled now.
   *  Never rejects. */
  reconciled: () => Promise<boolean>
  /** After the check, every lease `recovering` at this call has its recovery started; ends once
   *  each has ended or outlasted its budget. Never rejects. */
  recovered: () => Promise<void>
  /** A startup restore's resolver, after the check. A `recovering` lease answers its one recovery,
   *  or true once that outlasts its budget: a second beside it could hang the same way, so its chat
   *  opens unverified. Any other lease is resolved as `resolveRecovery` resolves it. */
  resolve: (sessionId: string) => Promise<boolean>
}

export function createStructuredAgentSessionStartupLeasePhase(deps: {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  logger: StructuredAgentSessionLogger
  /** The restart lease check; false when it failed (reported by it). Never rejects. */
  reconcile: (sessionId: string) => Promise<boolean>
  /** Resolves a `recovering` lease; never rejects. */
  resolveRecovery: (sessionId: string) => Promise<boolean>
  budgetMs?: number
}): StructuredAgentSessionStartupLeasePhase {
  const budgetMs = deps.budgetMs ?? RECOVERY_BUDGET_MS
  const recoveries = new Map<string, Promise<boolean>>()
  let checking: Promise<boolean> | null = null
  // A failed check is usually a store write that failed once, so it runs once more; past that, the
  // leases stay unchecked until an attach or send checks them. The answer is read from the records,
  // never kept, so a check a command completes later counts here too.
  const reconciled = async () => {
    await (checking ??= deps
      .reconcile('startup')
      .then((settled) => settled || deps.reconcile('startup')))
    return !deps.store.listRecords().some((record) => record.lease.unreconciled)
  }
  const recovering = (sessionId: string) =>
    deps.store.getRecord(sessionId)?.lease.handoffStage === 'recovering'
  const recoverOnce = (sessionId: string): Promise<boolean> => {
    let recovery = recoveries.get(sessionId)
    if (!recovery) {
      recovery = withTimeout<boolean | null>(deps.resolveRecovery(sessionId), budgetMs, null).then(
        (resolved) => {
          if (resolved !== null) {
            return resolved
          }
          deps.logger.warn('a chat recovery outlasted startup; left unverified', {
            scope: 'startup-recovery-timeout',
            sessionId
          })
          return true
        }
      )
      recoveries.set(sessionId, recovery)
    }
    return recovery
  }
  return {
    reconciled,
    recovered: async () => {
      await reconciled()
      await forEachWithConcurrency(
        deps.store.listRecords().filter((record) => record.lease.handoffStage === 'recovering'),
        RECOVERY_CONCURRENCY,
        async ({ sessionId }) => {
          await recoverOnce(sessionId)
        }
      )
    },
    resolve: async (sessionId) => {
      await reconciled()
      return recoveries.has(sessionId) || recovering(sessionId)
        ? recoverOnce(sessionId)
        : deps.resolveRecovery(sessionId)
    }
  }
}
