import { expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { ownerOpened, turnRows } from './bot-turn-rows'

const item = (
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem => ({ itemId, sequence, body, revision: 0, observedAt: sequence })

// A Claude send's turn names the provider echo's id; the owner's message keeps its send's id.
const earlier = item('earlier-result', 1, {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Before' }]
})
const items = [
  earlier,
  item('orca:send-1', 2, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Owner words' }]
  }),
  item('claude-turn-item', 3, {
    kind: 'turn',
    turnId: 'turn-1',
    userItemId: 'claude:provider-session:echo-1',
    state: 'completed',
    outcome: 'success'
  })
]
// The journal's alias of the echo's id: the row its send was kept under.
const journal = {
  items,
  openerIds: new Map([['claude:provider-session:echo-1', 'orca:send-1']])
}

it("reads a Claude turn's owner opener through its echo's alias", () => {
  expect(ownerOpened(journal, 'turn-1')).toBe(true)
  expect(turnRows(journal, 'turn-1', items).map((row) => row.itemId)).toEqual([
    'orca:send-1',
    'claude-turn-item'
  ])
})
