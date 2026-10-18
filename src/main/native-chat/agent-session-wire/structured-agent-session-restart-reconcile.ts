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
import type { JournalWriteOptions } from '../agent-session-journal/journal-database'

const MAX_RECONCILIATION_PASSES = 8

/** Adjudicates leases loaded by this process: one chat's, or with no id every chat's on this host.
 *  One run per target is in flight. Answers with the refusal attach owes its caller, or null once
 *  settled. */
export function createRestartReconciler(deps: {
  store: AgentSessionRecordStore
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeMany?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  now: () => number
}): (sessionId?: string, options?: JournalWriteOptions) => Promise<AgentSessionWireRefusal | null> {
  const pending = new Map<string | undefined, Promise<void>>()
  const background = new Map<string | undefined, Promise<void>>()
  return async (sessionId, options) => {
    if (!hasUnreconciledLease(deps.store, sessionId)) {
      return null
    }
    // Background bookkeeping joins a person's run for its target, or another background one, never
    // the reverse: no person's run inherits its refusal to wait for another connection's lock.
    if (options?.background && !pending.has(sessionId)) {
      await inFlight(background, sessionId, async () => {
        // The every-chat pass lets chat checks already under way finish first, so no chat is
        // probed twice by it.
        if (sessionId === undefined) {
          await Promise.allSettled(pending.values())
        }
        await reconcileCurrentLease(deps, sessionId, options)
      })
      return null
    }
    try {
      await inFlight(pending, sessionId, () => reconcileCurrentLease(deps, sessionId))
      return null
    } catch (error) {
      const record = sessionId === undefined ? undefined : deps.store.getRecord(sessionId)
      return classifyStoreFailure(error, record?.lease.runtimeFence ?? null, record)
    }
  }
}

/** The target's run in flight, started when none is. */
function inFlight(
  runs: Map<string | undefined, Promise<void>>,
  sessionId: string | undefined,
  start: () => Promise<void>
): Promise<void> {
  let run = runs.get(sessionId)
  if (!run) {
    run = start().finally(() => runs.delete(sessionId))
    runs.set(sessionId, run)
  }
  return run
}

/** Reports each distinct failure once, until `clear` says the bookkeeping settled again: the
 *  startup check, the restore pass and a restore retried after a failed journal open would each
 *  log the same store failure. */
export type ReaderBookkeepingFailures = {
  report: (failure: unknown) => void
  clear: () => void
}

/** Startup and the read carry on past a failure: the host's retry tries it again with a backoff,
 *  and the next attach or send reconciles and resolves recovery again before it acts. */
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
  sessionId?: string,
  options?: JournalWriteOptions
): Promise<void> {
  for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
    await deps.store.reconcileOnRestart(
      {
        ...(sessionId === undefined ? {} : { sessionId }),
        probe: deps.probe,
        ...(deps.probeMany ? { probeMany: deps.probeMany } : {}),
        now: deps.now()
      },
      options
    )
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
