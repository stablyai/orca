// Every lease loads from disk unreconciled: the process that wrote it may still
// be alive, so nothing the store persisted grants a writer until this host has
// adjudicated it. Without this an attach after a restart is refused forever with
// `execution_owner_reconciling`, and the session becomes unreachable.

import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { classifyStoreFailure } from './structured-agent-session-attach'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

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
}): (sessionId?: string) => Promise<AgentSessionWireRefusal | null> {
  const pending = new Map<string | undefined, Promise<void>>()
  return async (sessionId) => {
    if (!hasUnreconciledLease(deps.store, sessionId)) {
      return null
    }
    if (!pending.has(sessionId)) {
      const run = reconcileCurrentLease(deps, sessionId)
      pending.set(
        sessionId,
        run.finally(() => {
          pending.delete(sessionId)
        })
      )
    }
    try {
      await pending.get(sessionId)
      return null
    } catch (error) {
      const record = sessionId === undefined ? undefined : deps.store.getRecord(sessionId)
      return classifyStoreFailure(error, record?.lease.runtimeFence ?? null, record)
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

/** Startup and the read carry on past a failure: the next attach or send reconciles and resolves
 *  recovery again before it acts. */
export function reportEachFailureOnce(
  logger: StructuredAgentSessionLogger
): ReaderBookkeepingFailures {
  let reported: string | null = null
  return {
    report: (failure) => {
      const key = failureKey(failure)
      if (key !== reported) {
        reported = key
        logger.warn('chat lease bookkeeping for a read failed', {
          scope: 'lease-reconcile',
          error: failure
        })
      }
    },
    clear: () => {
      reported = null
    }
  }
}

/** The reconcile a reader runs, at startup and before each restored read: it never throws, since
 *  an unreconciled lease grants no writer and the next send reconciles again before it acts.
 *  Answers whether the leases it checked are settled. */
export function createReaderReconcile<Args extends unknown[]>(
  reconcile: (...args: Args) => Promise<AgentSessionWireRefusal | null>,
  failures: ReaderBookkeepingFailures
): (...args: Args) => Promise<boolean> {
  return async (...args) => {
    let failure: unknown
    try {
      const refusal = await reconcile(...args)
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

async function reconcileCurrentLease(
  deps: {
    store: AgentSessionRecordStore
    probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
    probeMany?: (
      records: readonly AgentSessionRecord[]
    ) => Promise<Map<string, AgentSessionOwnerProbe>>
    now: () => number
  },
  sessionId?: string
): Promise<void> {
  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
    await deps.store.reconcileOnRestart({
      ...(sessionId === undefined ? {} : { sessionId }),
      probe: deps.probe,
      ...(deps.probeMany ? { probeMany: deps.probeMany } : {}),
      now: deps.now()
    })
    if (!hasUnreconciledLease(deps.store, sessionId)) {
      return
    }
  }
  // An outgoing runtime can still be writing during restart; preserve the record and retry later.
  throw new Error('execution_owner_reconciling')
}

function hasUnreconciledLease(store: AgentSessionRecordStore, sessionId?: string): boolean {
  return sessionId === undefined
    ? store.listRecords().some((record) => record.lease.unreconciled)
    : store.getRecord(sessionId)?.lease.unreconciled === true
}
