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
import { mapSettledWithConcurrency } from '../../../shared/map-with-concurrency'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  OpenedStructuredAgentSessionConversation,
  StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'
import { restoreStructuredAgentSessionRead } from './structured-agent-session-read-restore'

// One chat at a time after the listing: the restore is CPU-bound on the main thread, so more lanes
// only lengthen each event-loop turn that a user's read or send waits behind. The pass before the
// listing sets its own.
const JOURNAL_RESTORE_CONCURRENCY = 1

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
  /** Quit has begun: the restore opens nothing more. */
  isDisposed: () => boolean
  /** Whether the chat still has its tab: one closed while the restore ran stays closed. */
  isListed: (sessionId: string) => boolean
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
  if (input.isDisposed()) {
    return
  }
  await settleLeases(sessionId)
  await input.serialize(sessionId, () =>
    restoreOneStructuredAgentSessionReadUnderSerialize(input, sessionId)
  )
}

/** The serialized half of the restore. */
async function restoreOneStructuredAgentSessionReadUnderSerialize(
  input: Pick<
    StructuredAgentSessionReadRestoreDeps,
    'openDeps' | 'hasSession' | 'isDisposed' | 'isListed' | 'onReadable'
  >,
  sessionId: string
): Promise<void> {
  // Checked under the chat's serialize, where its close and quit's teardown also run.
  if (input.isDisposed() || !input.isListed(sessionId)) {
    return
  }
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
  input: StructuredAgentSessionReadRestoreDeps & {
    records: AgentSessionRecord[]
    concurrency?: number
  }
): Promise<void> {
  const [first] = input.records
  if (!first) {
    return
  }
  // One check for the pass, and per chat (startup answers both from its lease phase, which checks
  // once); after the first failure, retrying per chat only waits on the same store again, and the
  // next attach or send settles those chats instead.
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
  const results = await mapSettledWithConcurrency(
    input.records,
    input.concurrency ?? JOURNAL_RESTORE_CONCURRENCY,
    async ({ sessionId }) => {
      // A journal open is synchronous SQLite: without a macrotask per chat the restore is one long task.
      await yieldToEventLoop()
      await restoreOneStructuredAgentSessionRead(input, sessionId, settleLeases)
    }
  )
  // One chat's failure costs only that chat, which opens again when it is read.
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      input.openDeps.logger.warn('restoring a chat for reading failed', {
        scope: 'history-restore-chat',
        sessionId: input.records[index]?.sessionId,
        error: result.reason
      })
    }
  })
}
