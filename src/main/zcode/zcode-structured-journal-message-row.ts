// One whole ZCode message → the journal message row it owns.
//
// Payload readers: zcode-structured-journal-payload-readers.ts.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { readZcodeMessageParts } from './zcode-protocol-events'
import { readRecord, readString } from './zcode-structured-journal-payload-readers'
import { zcodeMessageIdentity } from './zcode-structured-journal-sink'

export type ZcodeJournalMessageRow = {
  messageId: string
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

/**
 * `null` for a message this host cannot name or that carries no blocks.
 * `claimUserMessage` runs for a user message so the caller can attach it to the
 * turn it belongs to — the first one wins.
 */
export function zcodeJournalMessageRow(
  message: unknown,
  timestamp: number | null,
  claimUserMessage: (messageId: string) => void
): ZcodeJournalMessageRow | null {
  // Some builds file the id inside `info` rather than at the top level; skipping
  // those would silently drop the message from a resumed chat.
  const messageId =
    readString(message, 'messageId') ?? readString(readRecord(message, 'info') ?? {}, 'messageId')
  const role = readString(readRecord(message, 'info') ?? message, 'role') ?? 'assistant'
  const blocks = readZcodeMessageParts(message)
  if (!messageId || blocks.length === 0) {
    return null
  }
  const isUser = role === 'user'
  if (isUser) {
    claimUserMessage(messageId)
  }
  return {
    messageId,
    identity: zcodeMessageIdentity(messageId),
    body: {
      kind: 'message',
      role: isUser ? 'user' : 'assistant',
      blocks,
      state: 'completed',
      ...(timestamp === null ? {} : { completedAt: timestamp })
    }
  }
}
