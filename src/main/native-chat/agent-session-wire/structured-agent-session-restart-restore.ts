// What a restart owes a persisted session, and what it does NOT.
//
// It owes reconciliation — every lease loaded from disk names an owner from a process generation
// that no longer exists, and adjudicating that is startup's job. It owes an exit from any recovery
// stage the evidence now permits. And it owes a READABLE session: the journal open, history
// answerable, the tab restorable.
//
// It does not owe a provider child. This used to resume every record whose lease was `released`,
// which is the normal end state of a chat the user closed cleanly — so a
// healthy profile started an app-server per session it had ever used, in parallel, at every launch,
// with no client attached and nothing on screen. A child now exists because a surface asked for the
// session (see `structured-agent-session-holds`), not because a record survived on disk.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  restoreStructuredAgentSessionRead,
  type RestoredStructuredAgentSessionRead
} from './structured-agent-session-read-restore'

const JOURNAL_RESTORE_CONCURRENCY = 4

export type StructuredAgentSessionReadRestoreDeps = {
  store: AgentSessionRecordStore
  journalRoot: string
  reconcile: (sessionId: string) => Promise<AgentSessionWireRefusal | null>
  resolveRecovery: (sessionId: string) => Promise<unknown>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  onReadable: (sessionId: string, restored: RestoredStructuredAgentSessionRead) => void
  retrySettlement: (
    sessionId: string,
    params: RestoredStructuredAgentSessionRead['params']
  ) => Promise<boolean>
}

/**
 * One session's share of the restart restore, and the whole of an on-demand one.
 *
 * Startup maps this over every supported record; a surface asking for a session it cannot see
 * calls it for one id. The CALLER decides which records are eligible — startup filters by
 * `supportsRecord` before mapping, so an on-demand caller owes the same check.
 */
export async function restoreOneStructuredAgentSessionRead(
  input: StructuredAgentSessionReadRestoreDeps,
  sessionId: string
): Promise<void> {
  const unreconciled = await input.reconcile(sessionId)
  if (!unreconciled) {
    // A session latched in recovery exits here at startup, without waiting for a client.
    await input.resolveRecovery(sessionId)
  }
  await input.serialize(sessionId, () =>
    restoreOneStructuredAgentSessionReadUnderSerialize(input, sessionId)
  )
}

/** The serialized half of the restore, for a caller already inside the session's serialize — a
 *  send replaying into a session this host has closed, which needs the journal and no child. */
export async function restoreOneStructuredAgentSessionReadUnderSerialize(
  input: Pick<
    StructuredAgentSessionReadRestoreDeps,
    'store' | 'journalRoot' | 'hasSession' | 'onReadable' | 'retrySettlement'
  >,
  sessionId: string
): Promise<void> {
  if (input.hasSession(sessionId)) {
    // A surface that took a hold mid-restore already attached this one.
    return
  }
  const restored = await restoreStructuredAgentSessionRead(
    input.store,
    input.journalRoot,
    sessionId
  )
  if (!restored) {
    return
  }
  input.onReadable(sessionId, restored)
  await input.retrySettlement(sessionId, restored.params)
}

export async function restoreStructuredAgentSessionsOnRestart(
  input: StructuredAgentSessionReadRestoreDeps & { records: AgentSessionRecord[] }
): Promise<void> {
  await mapWithConcurrency(input.records, JOURNAL_RESTORE_CONCURRENCY, ({ sessionId }) =>
    restoreOneStructuredAgentSessionRead(input, sessionId)
  )
}
