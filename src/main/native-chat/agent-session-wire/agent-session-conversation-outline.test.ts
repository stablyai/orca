import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS } from '../../../shared/agent-session-conversation-outline'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { readAgentSessionConversationOutline } from './agent-session-conversation-outline'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'

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
  it('echoes the journal position it is current through and cuts previews on the host', () => {
    const long = 'word '.repeat(200)
    const outline = readAgentSessionConversationOutline(
      snapshot([prompt(3, 'short'), prompt(9, long)])
    )
    expect(outline.cursor).toEqual({ epoch: 'epoch-1', sequence: 9 })
    expect(outline.sessionId).toBe('session-1')
    expect(outline.omittedEntries).toBe(0)
    expect(outline.entries.map((entry) => entry.sequence)).toEqual([3, 9])
    expect(outline.entries[0]?.preview).toBe('short')
    expect(outline.entries[1]?.preview.length).toBeLessThanOrEqual(
      AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS
    )
    expect(long.replace(/\s+/g, ' ').trim().startsWith(outline.entries[1]!.preview)).toBe(true)
  })

  it('drops previews before it drops entries, then drops the oldest entries, never passing the budget', () => {
    const items = Array.from({ length: 40 }, (_, index) => prompt(index + 1, 'x'.repeat(500)))
    const full = readAgentSessionConversationOutline(snapshot(items), Number.MAX_SAFE_INTEGER)
    // Room for every entry with a short preview but not a full one.
    const shortBudget = replyBytes(
      full.entries.map((entry) => ({ ...entry, preview: entry.preview.slice(0, 60) }))
    )
    expect(shortBudget).toBeLessThan(replyBytes(full.entries))
    const shortened = readAgentSessionConversationOutline(snapshot(items), shortBudget)
    expect(shortened.entries).toHaveLength(40)
    expect(shortened.entries.every((entry) => entry.preview.length === 60)).toBe(true)
    expect(replyBytes(shortened.entries)).toBeLessThanOrEqual(shortBudget)

    // Room for bare entries only.
    const bare = readAgentSessionConversationOutline(
      snapshot(items),
      replyBytes(full.entries.map((entry) => ({ ...entry, preview: '' })))
    )
    expect(bare.entries).toHaveLength(40)
    expect(bare.entries.every((entry) => entry.preview === '')).toBe(true)

    // Too small for every bare entry: the oldest go, the newest stay.
    const budget = 10 * replyBytes(bare.entries[0])
    const trimmed = readAgentSessionConversationOutline(snapshot(items), budget)
    expect(trimmed.omittedEntries).toBeGreaterThan(0)
    expect(trimmed.entries.at(-1)?.sequence).toBe(40)
    expect(trimmed.entries[0]?.sequence).toBe(trimmed.omittedEntries + 1)
    expect(replyBytes(trimmed.entries)).toBeLessThanOrEqual(budget)
  })

  it('stays inside the history page budget for a journal far past it', () => {
    // ~10k prompts of 1 KB each: an order of magnitude past the budget at full preview.
    const items = Array.from({ length: 10_000 }, (_, index) =>
      prompt(index + 1, `${index} ${'y'.repeat(1_000)}`)
    )
    const outline = readAgentSessionConversationOutline(snapshot(items))
    expect(replyBytes(outline)).toBeLessThanOrEqual(HISTORY_PAGE_CONTENT_BUDGET_BYTES)
    expect(outline.entries.at(-1)?.itemId).toBe('user-10000')
  })
})
