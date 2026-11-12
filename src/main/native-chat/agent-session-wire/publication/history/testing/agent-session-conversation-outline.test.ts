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

  // Newer clients ignore an unmarked outline, which older hosts may fill with agent-written inputs.
  it('marks its outline as listing only messages a person wrote', () => {
    expect(readAgentSessionConversationOutline(snapshot([]))).toEqual({
      sessionId: 'session-1',
      humanMessagesOnly: true,
      cursor: { epoch: 'epoch-1', sequence: 0 },
      entries: [],
      omittedEntries: 0
    })
  })

  it('omits sent [Image #N] markers from user message outline previews', () => {
    const outline = readAgentSessionConversationOutline(
      snapshot([
        {
          itemId: 'user-1',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              { type: 'text', text: 'Compare [Image #1] with baseline' },
              { type: 'image-ref', path: '/tmp/shot.png' }
            ]
          }
        }
      ])
    )
    expect(outline.entries).toEqual([
      {
        itemId: 'user-1',
        sequence: 1,
        preview: 'Compare with baseline',
        imageCount: 1
      }
    ])
  })
})
