import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
import { subagentGroupJournalBody } from '../native-chat/agent-session-journal/journal-subagent-group-body'
import { recordingSubagentRowSink } from '../native-chat/subagent-row-sink-recorder-test-support'
import {
  CodexSubagentRoster,
  codexSubagentGroupId,
  codexSubagentGroupIdentity
} from './codex-subagent-roster'

const PARENT = 'thread-parent'
const OUTSIDE = codexSubagentGroupId(PARENT, null)

describe('Codex subagent roster after a provider restart', () => {
  it('continues the row no turn owns instead of rewriting it from one child', () => {
    const recorder = recordingSubagentRowSink()
    const earlier = subagentGroupJournalBody(OUTSIDE, [
      { id: 'c1', label: 'one', state: 'completed', startedAt: 1, settledAt: 2 },
      { id: 'c2', label: 'two', state: 'unverifiable', startedAt: 1 }
    ])
    const roster = new CodexSubagentRoster({
      sink: {
        ...recorder.sink,
        journalLinkage: () => ({
          epoch: 'e1',
          visitItemsWithLinkage: (visit) =>
            visit(agentJournalItemKey(codexSubagentGroupIdentity(OUTSIDE)), 1, earlier, {
              turnScope: { kind: 'thread' }
            })
        })
      },
      primaryThreadId: () => PARENT,
      activeTurn: () => null,
      turnScopeFor: () => ({ kind: 'thread' })
    })
    roster.handleTurn({ threadId: 'c3', turnId: 't3', state: 'working' })
    roster.handleItem({
      threadId: PARENT,
      turnId: null,
      item: {
        type: 'subAgentActivity',
        id: 'i3',
        kind: 'started',
        agentThreadId: 'c3',
        agentPath: '/root/three'
      }
    })

    const last = recorder.log.findLast((write) => write.op === 'append')
    const agents =
      last?.op === 'append' && last.body.kind === 'message'
        ? last.body.blocks.find(isSubagentGroupBlock)?.agents
        : undefined
    expect(last?.op === 'append' && last.identity).toEqual(codexSubagentGroupIdentity(OUTSIDE))
    expect(agents?.map((agent) => [agent.id, agent.label, agent.state])).toEqual([
      ['c1', 'one', 'completed'],
      ['c2', 'two', 'unverifiable'],
      ['c3', 'three', 'working']
    ])
  })
})
