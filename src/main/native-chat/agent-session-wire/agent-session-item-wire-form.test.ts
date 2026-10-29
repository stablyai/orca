import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { journalPayload } from '../agent-session-journal/journal-payload-bounds'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { agentJournalItemForWire, shortenedAgentJournalItem } from './agent-session-item-wire-form'

it('preserves the full previously readable desktop message range', () => {
  const item: AgentJournalRenderItem = {
    itemId: 'message',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: `${'x'.repeat(1_200_000)}TAIL` }]
    }
  }
  const formed = agentJournalItemForWire(item)
  expect(formed.item).toBe(item)
  expect(formed.bytes).toBe(Buffer.byteLength(JSON.stringify(item), 'utf8'))
})

it.each([73_728, HISTORY_PAGE_CONTENT_BUDGET_BYTES, 4 * 1024 * 1024])(
  'keeps tool identity and output when cardinality exceeds %i bytes',
  (budget) => {
    const item: AgentJournalRenderItem = {
      itemId: 'call',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        callId: 'call',
        name: 'query',
        state: 'completed',
        input: { values: Array(Math.ceil(budget / 2) + 1_000).fill(0) },
        output: journalPayload('done')
      }
    }
    const sent = shortenedAgentJournalItem(item, budget)
    expect(sent).toMatchObject({
      itemId: 'call',
      shortened: true,
      body: {
        kind: 'tool-call',
        name: 'query',
        input: { truncated: true },
        output: { head: 'done' }
      }
    })
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThanOrEqual(budget)
  }
)
