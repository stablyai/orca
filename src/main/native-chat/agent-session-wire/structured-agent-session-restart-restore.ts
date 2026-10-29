// Reconcile ownership and restore readable journals without spawning providers for every saved chat.

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
    store: Pick<AgentSessionRecordStore, 'getRecord' | 'listConversations'>
  }
  // Reader bookkeeping cannot grant a writer and must not block reads.
  reconcileAll: () => Promise<boolean>
  reconcile: (sessionId: string) => Promise<boolean>
  /** Failed writes retry strictly on the next attach/send. */
  resolveRecovery: (sessionId: string) => Promise<boolean>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  /** Failed opens retain tabs for readable failure/retry. */
  onUnopened?: (sessionId: string) => void
  onReadable: (
    sessionId: string,
    opened: OpenedStructuredAgentSessionConversation
  ) => Promise<void> | void
}

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

async function restoreOneStructuredAgentSessionReadUnderSerialize(
  input: Pick<StructuredAgentSessionReadRestoreDeps, 'openDeps' | 'hasSession' | 'onReadable'>,
  sessionId: string
): Promise<void> {
  if (input.hasSession(sessionId)) {
    return
  }
  const opened = await restoreStructuredAgentSessionRead(input.openDeps, sessionId)
  if (!opened) {
    return
  }
  await input.onReadable(sessionId, opened)
}

export async function restoreStructuredAgentSessionsOnRestart(
  input: StructuredAgentSessionReadRestoreDeps & {
    records: Pick<AgentSessionRecord, 'sessionId'>[]
  }
): Promise<void> {
  if (input.records.length === 0) {
    return
  }
  // Avoid per-chat store retries after a failed host-wide pass; explicit actions retry later.
  let settled = await input.reconcileAll()
  const settleLeases = async (sessionId: string): Promise<void> => {
    if (
      settled &&
      input.openDeps.store.getRecord(sessionId) &&
      !((await input.reconcile(sessionId)) && (await input.resolveRecovery(sessionId)))
    ) {
      settled = false
    }
  }
  await mapWithConcurrency(input.records, JOURNAL_RESTORE_CONCURRENCY, async ({ sessionId }) => {
    // Synchronous SQLite opens need a macrotask per chat to keep startup responsive.
    await yieldToEventLoop()
    // Isolate failed opens so other chats still restore.
    await restoreOneStructuredAgentSessionRead(input, sessionId, settleLeases).catch(
      (error: unknown) => {
        input.openDeps.logger.warn('restoring a chat at startup failed', {
          scope: 'restart-restore',
          sessionId,
          error
        })
        input.onUnopened?.(sessionId)
      }
    )
  })
}
