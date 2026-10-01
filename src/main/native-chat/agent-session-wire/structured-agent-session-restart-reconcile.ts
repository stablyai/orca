// Every lease loads from disk unreconciled: the process that wrote it may still
// be alive, so nothing the store persisted grants a writer until this host has
// adjudicated it. Without this an attach after a restart is refused forever with
// `execution_owner_reconciling`, and the session becomes unreachable.

import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { classifyStoreFailure } from './structured-agent-session-attach'

const MAX_RECONCILIATION_PASSES = 8

/** Adjudicates leases loaded by this process.
 *  Answers with the refusal attach owes its caller, or null once settled. */
export function createRestartReconciler(deps: {
  store: AgentSessionRecordStore
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeMany?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  now: () => number
}): (sessionId: string) => Promise<AgentSessionWireRefusal | null> {
  let pending: Promise<void> | null = null
  return async (sessionId) => {
    if (!deps.store.listRecords().some((record) => record.lease.unreconciled)) {
      return null
    }
    if (!pending) {
      const run = reconcileCurrentLeases(deps)
      pending = run.finally(() => {
        pending = null
      })
    }
    try {
      await pending
      return null
    } catch (error) {
      return classifyStoreFailure(
        error,
        deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null,
        deps.store.getRecord(sessionId)
      )
    }
  }
}

/** Reports each distinct failure once, until `clear` says the bookkeeping settled again: the
 *  startup check, the restore pass and a restore retried after a failed journal open would each
 *  log the same store failure. */
export type ReaderBookkeepingFailures = {
  report: (failure: unknown) => void
  clear: () => void
}

export function reportEachFailureOnce(
  onFailure: ((failure: unknown) => void) | undefined
): ReaderBookkeepingFailures {
  let reported: string | null = null
  return {
    report: (failure) => {
      const key = failureKey(failure)
      if (key !== reported) {
        reported = key
        try {
          onFailure?.(failure)
        } catch (sinkError) {
          // A throwing sink must not turn the reported failure back into a failed read.
          console.warn('[structured-agent-session] reporting a lease bookkeeping failure failed', {
            failure,
            sinkError
          })
        }
      }
    },
    clear: () => {
      reported = null
    }
  }
}

/** The reconcile a reader runs, at startup and before each restored read: it never throws, since
 *  an unreconciled lease grants no writer and the next send reconciles again before it acts.
 *  Answers whether every lease is settled. */
export function createReaderReconcile(
  reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>,
  failures: ReaderBookkeepingFailures
): (sessionId: string) => Promise<boolean> {
  return async (sessionId) => {
    let failure: unknown
    try {
      const refusal = await reconcile(sessionId)
      if (!refusal) {
        failures.clear()
        return true
      }
      failure = refusal
    } catch (error) {
      failure = error
    }
    failures.report(failure)
    return false
  }
}

function failureKey(failure: unknown): string {
  if (typeof failure === 'object' && failure !== null) {
    if ('code' in failure && failure.code) {
      return String(failure.code)
    }
    if ('message' in failure) {
      return String(failure.message)
    }
  }
  return String(failure)
}

async function reconcileCurrentLeases(deps: {
  store: AgentSessionRecordStore
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeMany?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  now: () => number
}): Promise<void> {
  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
    await deps.store.reconcileOnRestart({
      probe: deps.probe,
      ...(deps.probeMany ? { probeMany: deps.probeMany } : {}),
      now: deps.now()
    })
    if (!deps.store.listRecords().some((record) => record.lease.unreconciled)) {
      return
    }
  }
  // An outgoing runtime can still be writing during restart; preserve the record and retry later.
  throw new Error('execution_owner_reconciling')
}
