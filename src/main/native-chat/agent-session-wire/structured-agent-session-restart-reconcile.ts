// Persisted leases grant no writer until this runtime reconciles them; their recorded process may still live.

import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { classifyStoreFailure } from './structured-agent-session-attach'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

const MAX_RECONCILIATION_PASSES = 8

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

/** Deduplicate failures across startup/restore retries until bookkeeping succeeds. */
export type ReaderBookkeepingFailures = {
  report: (failure: unknown) => void
  clear: () => void
}

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

/** Reader reconciliation never throws or grants ownership; attach/send must retry strictly before acting. */
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
