// Every lease loads from disk unreconciled: the process that wrote it may still
// be alive, so nothing the store persisted grants a writer until this host has
// adjudicated it. Without this an attach after a restart is refused forever with
// `execution_owner_reconciling`, and the session becomes unreachable.

import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { classifyStoreFailure } from './structured-agent-session-attach'

/** Adjudicates leases loaded by this process or refreshed from another writer.
 *  Answers with the refusal attach owes its caller, or null once settled. */
export function createRestartReconciler(deps: {
  store: AgentSessionRecordStore
  probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  now: () => number
}): (sessionId: string) => Promise<AgentSessionWireRefusal | null> {
  let pending: Promise<void> | null = null
  return async (sessionId) => {
    if (!deps.store.listRecords().some((record) => record.lease.unreconciled)) {
      return null
    }
    if (!pending) {
      const run = deps.store
        .reconcileOnRestart({ probe: deps.probe, now: deps.now() })
        .then(() => undefined)
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
        deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
      )
    }
  }
}
