import { describe, expect, it } from 'vitest'

import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentSessionConversationOutline } from '../agent-session-conversation-outline'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../agent-session-history-page-bounds'

function prompt(sequence: number, text: string): AgentJournalRenderItem {
  return {
    itemId: `user-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
  }
}

function snapshot(items: AgentJournalRenderItem[]): AgentJournalSnapshot {
  return {
    sessionId: 'session-1',
    cursor: { epoch: 'epoch-1', sequence: items.at(-1)?.sequence ?? 0 },
    items,
    submissions: []
  }
}

function replyBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

describe('conversation outline read', () => {
  it('stays inside the history page budget for a journal far past it', () => {
    const items = Array.from({ length: 10_000 }, (_, index) =>
      prompt(index + 1, `${index} ${'y'.repeat(1_000)}`)
    )
    const outline = readAgentSessionConversationOutline(snapshot(items))
    expect(replyBytes(outline)).toBeLessThanOrEqual(HISTORY_PAGE_CONTENT_BUDGET_BYTES)
    expect(outline.entries.at(-1)?.itemId).toBe('user-10000')
  })
})
