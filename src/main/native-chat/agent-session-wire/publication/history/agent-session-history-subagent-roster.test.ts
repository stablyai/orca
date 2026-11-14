import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { offPageSubagentRoster } from './agent-session-history-subagent-roster'

it('supplies the off-page owner name for a page containing only its shell task', () => {
  const entry = { id: 'owner', label: 'Audit', state: 'stopped' as const }
  const owner: AgentJournalRenderItem = {
    itemId: 'owner-row',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' },
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ ...entry, type: 'subagent', groupId: 'turn' }]
    }
  }
  const shell: AgentJournalRenderItem = {
    itemId: 'shell-row',
    sequence: 2,
    revision: 1,
    observedAt: 2,
    turnScope: { kind: 'thread' },
    agentId: 'shell',
    parentAgentId: 'owner',
    producerKind: 'background',
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'background-task',
          taskId: 'shell',
          kind: 'command',
          label: 'sleep',
          state: 'working'
        }
      ]
    }
  }
  expect(offPageSubagentRoster([owner, shell], [shell])).toMatchObject([{ entry }])
})
