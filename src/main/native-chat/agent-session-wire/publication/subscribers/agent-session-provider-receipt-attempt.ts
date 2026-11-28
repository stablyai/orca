import type { AgentSessionSubscribeEvent } from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { SqlAgentSessionJournal } from '../../../agent-session-journal/journal-sql-store'
import type { Subscriber } from './agent-session-subscribe-input'

export type ProviderReceiptDispatch = {
  journal: SqlAgentSessionJournal
  clientMessageId: string
  cursor: AgentJournalCursor
  fence: number
  provider: 'claude' | 'codex'
  owns: () => boolean
  readFence?: () => number | undefined
}
export type ReceiptLink = { attempt?: Attempt }
export type Attempt = ProviderReceiptDispatch & {
  readers: Set<Subscriber>
  link: ReceiptLink
  pending?: () => boolean
}
export type SessionAttempts = {
  journal: SqlAgentSessionJournal
  epoch: string
  fence: number
  bySequence: Map<number, Attempt | string>
  changed: Set<Attempt>
  readFence?: ProviderReceiptDispatch['readFence']
}

export type EmittedReceiptCursor = { cursor: AgentJournalCursor; fence: number }

export function coversBeforeHandover(
  reader: Subscriber,
  emitted: EmittedReceiptCursor | undefined,
  cursor: AgentJournalCursor,
  fence: number
): boolean {
  return (
    emitted?.cursor.epoch === cursor.epoch &&
    emitted.cursor.sequence >= cursor.sequence - 1 &&
    emitted.fence === fence &&
    reader.fence === fence
  )
}

export function receiptCursorOf(
  event: AgentSessionSubscribeEvent,
  fence: number
): EmittedReceiptCursor | undefined {
  if (event.type === 'batch') {
    return { cursor: event.batch.cursor, fence: event.fence ?? fence }
  }
  if (event.type !== 'end') {
    return { cursor: event.page.liveCursor ?? event.page.window.nextCursor, fence: event.fence }
  }
  return undefined
}
