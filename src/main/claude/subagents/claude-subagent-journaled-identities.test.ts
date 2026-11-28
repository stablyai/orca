import { describe, expect, it } from 'vitest'
import type { JournalItemLinkageVisitor } from '../../native-chat/agent-session-journal/journal-store-contracts'
import {
  ClaudeJournaledSubagents,
  readClaudeJournalSnapshot
} from './claude-subagent-journaled-identities'

// A reattach maps a live subagent frame (named by its launching call) to the saved subagent.
describe('Claude journaled subagent identities', () => {
  it('maps a launching call to the subagent its saved roster row names, with no row of its own', () => {
    const rosterRow = {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'subagent',
          id: 'ad66d300cc4eb491a',
          groupId: 'turn-1',
          run: 'toolu_launch',
          background: true,
          name: 'Write numbered list',
          state: 'running'
        }
      ]
    }
    const snapshot = readClaudeJournalSnapshot({
      visitItemsWithLinkage: (visit: JournalItemLinkageVisitor) =>
        // @ts-expect-error a minimal saved row: only what the reading looks at
        visit('row-1', 1, rosterRow, { producerKind: 'root' }),
      threadGoalSource: () => ({ goal: null, row: null })
    })
    const identities = new ClaudeJournaledSubagents(() => snapshot)
    expect(identities.canonical('toolu_launch')).toBe('ad66d300cc4eb491a')
    expect(identities.launchOf('ad66d300cc4eb491a')).toBe('toolu_launch')
  })
})
