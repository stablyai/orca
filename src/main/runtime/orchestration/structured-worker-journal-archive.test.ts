import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { buildStructuredJournalArchive } from './structured-worker-journal-archive'

const STRUCTURED_ARCHIVE_MAX_BYTES = 262_144

/** A worker that actually did work: every turn is a full-width message, so the projected journal
 *  is several times the wire-size bound the forward transcript page uses. */
function longJournal(count: number): AgentJournalRenderItem[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        itemId: `item-${index}`,
        observedAt: index,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: Array.from({ length: 6 }, (_block, slot) => ({
            type: 'text',
            text: `${index}:${slot}:${'x'.repeat(1_200)}`
          }))
        }
      }) as unknown as AgentJournalRenderItem
  )
}

function archive(items: AgentJournalRenderItem[], hasOlder = false) {
  return buildStructuredJournalArchive({
    agent: 'claude',
    processIncarnation: 'structured:session-1',
    items,
    hasOlder
  })
}

describe('buildStructuredJournalArchive', () => {
  it('keeps the worker final answer when the journal exceeds the bound', () => {
    // The whole reason a released worker is read back. Bounding forward first kept the HEAD — the
    // dispatch preamble and early exploration — and the newest-first cap then trimmed that head,
    // so the answer was gone while the receipt said only the oldest messages had been dropped.
    const items = longJournal(200)
    const built = archive(items)
    expect(built.limited).toBe(true)
    expect(built.messages.at(-1)?.id).toBe('item-199')
    expect(built.messages[0]?.id).not.toBe('item-0')
  })

  it('reports the end it actually dropped', () => {
    const built = archive(longJournal(200))
    expect(built.warnings).toContain(
      'The oldest archived journal messages were dropped to fit the size bound.'
    )
    expect(built.warnings).not.toContain('Transcript response was clipped to the wire-size limit.')
  })

  it('stays inside the durable bound', () => {
    const built = archive(longJournal(200))
    expect(Buffer.byteLength(JSON.stringify(built.messages), 'utf8')).toBeLessThanOrEqual(
      STRUCTURED_ARCHIVE_MAX_BYTES
    )
  })

  it('keeps a short journal whole and unflagged', () => {
    const built = archive(longJournal(3))
    expect(built.limited).toBe(false)
    expect(built.messages.map((message) => message.id)).toEqual(['item-0', 'item-1', 'item-2'])
    expect(built.warnings).not.toContain(
      'The oldest archived journal messages were dropped to fit the size bound.'
    )
  })

  it('still reports omitted older items when the page itself was bounded', () => {
    const built = archive(longJournal(2), true)
    expect(built.limited).toBe(true)
    expect(built.warnings).toContain('Older journal items were omitted from the bounded archive.')
  })
})
