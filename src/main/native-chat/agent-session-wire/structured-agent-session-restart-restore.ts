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
// with no client attached and nothing on screen. A child now exists because work asked for it — a
// send, through the delivery loop — not because a record survived on disk.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  OpenedStructuredAgentSessionConversation,
  StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

const JOURNAL_RESTORE_CONCURRENCY = 4

export type StructuredAgentSessionReadRestoreDeps = {
  openDeps: StructuredAgentSessionConversationOpenDeps & {
    store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  }
  // Lease bookkeeping. Neither throws: a read grants no writer, so bookkeeping must not block it.
  /** Whether every lease is settled. */
  reconcile: (sessionId: string) => Promise<boolean>
  /** False when its store write failed; the next attach or send resolves it again. */
  resolveRecovery: (sessionId: string) => Promise<boolean>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  onReadable: (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ) => Promise<void> | void
}

/** One session's share of the restart restore. Startup maps this over every supported record. */
async function restoreOneStructuredAgentSessionRead(
  input: StructuredAgentSessionReadRestoreDeps,
  sessionId: string,
  settleLeases: (sessionId: string) => Promise<void>
): Promise<void> {
  await settleLeases(sessionId)
  await input.serialize(sessionId, () =>
    restoreOneStructuredAgentSessionReadUnderSerialize(input, sessionId)
  )
}

/** The serialized half of the restore. */
async function restoreOneStructuredAgentSessionReadUnderSerialize(
  input: Pick<StructuredAgentSessionReadRestoreDeps, 'openDeps' | 'hasSession' | 'onReadable'>,
  sessionId: string
): Promise<void> {
  if (input.hasSession(sessionId)) {
    // A read or a send mid-restore already opened this one.
    return
  }
  const opened = await restoreStructuredAgentSessionRead(input.openDeps, sessionId)
  if (!opened) {
    return
  }
  // The open settled what a gone generation left running, so no reader sees it run.
  await input.onReadable(sessionId, opened)
}

export async function restoreStructuredAgentSessionsOnRestart(
  input: StructuredAgentSessionReadRestoreDeps & { records: AgentSessionRecord[] }
): Promise<void> {
  const [first] = input.records
  if (!first) {
    return
  }
  // One check for the pass. Each chat checks again while it holds, since another writer can mark
  // leases unreconciled mid-pass; after the first failure, retrying per chat only waits on the
  // same store again, and the next attach or send settles those chats instead.
  let settled = await input.reconcile(first.sessionId)
  const settleLeases = async (sessionId: string): Promise<void> => {
    // A session latched in recovery exits here at startup, without waiting for a client.
    if (
      settled &&
      !((await input.reconcile(sessionId)) && (await input.resolveRecovery(sessionId)))
    ) {
      settled = false
    }
  }
  await mapWithConcurrency(input.records, JOURNAL_RESTORE_CONCURRENCY, async ({ sessionId }) => {
    // A journal open is synchronous SQLite: without a macrotask per chat the restore is one long task.
    await yieldToEventLoop()
    await restoreOneStructuredAgentSessionRead(input, sessionId, settleLeases)
  })
}
