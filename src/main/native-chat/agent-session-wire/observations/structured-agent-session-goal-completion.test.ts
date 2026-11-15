import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoalStatus
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { currentAgentSessionThreadGoal } from '../../../../shared/agent-session/agent-session-thread-goal'
import { projectStructuredAgentSessionStatusState } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

function rig() {
  const items: AgentJournalRenderItem[] = []
  const events: AgentSessionTurnCompletionEvent[] = []
  function append(body: AgentJournalRenderItem['body']) {
    const sequence = items.length + 1
    items.push({ itemId: `item-${sequence}`, revision: 0, sequence, observedAt: sequence, body })
    feed.observe('session')
  }
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions: new Map([
      [
        'session',
        {
          journal: {
            cursor: () => ({ epoch: 'epoch', sequence: items.length }),
            threadGoal: () => currentAgentSessionThreadGoal(items) ?? null
          },
          params: {
            location: {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'folder:test',
              workspaceKind: 'folder'
            }
          }
        }
      ]
    ]),
    now: () => 100,
    readStatusState: () => projectStructuredAgentSessionStatusState(items),
    readChildWork: () => undefined
  })
  feed.subscribe({ id: 'notifications', includePrompts: true, emit: (event) => events.push(event) })
  append({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Finish the migration' }]
  })
  function goal(status: AgentJournalThreadGoalStatus) {
    append({
      kind: 'status',
      text: 'Goal transition',
      threadGoal: {
        state: 'set',
        goal: {
          objective: 'Finish the migration',
          status,
          tokenBudget: null,
          tokensUsed: 10,
          timeUsedSeconds: 30,
          createdAt: 1,
          updatedAt: items.length
        }
      }
    })
  }
  function turn(turnId: string, outcome?: 'success') {
    append({
      kind: 'turn',
      turnId,
      state: outcome ? 'completed' : 'running',
      ...(outcome ? { outcome } : {})
    })
  }
  return { append, goal, turn, events, observe: () => feed.observe('session') }
}

it('announces only the final settle across autonomous goal turns', () => {
  const r = rig()
  r.goal('active')
  r.turn('first')
  r.turn('first', 'success')
  r.observe()
  expect(r.events).toEqual([])
  r.turn('continuation')
  r.turn('continuation', 'success')
  expect(r.events).toEqual([])
  r.goal('complete')
  r.observe()
  expect(r.events).toEqual([
    expect.objectContaining({
      type: 'completion',
      completion: expect.objectContaining({ turnId: 'continuation', outcome: 'success' })
    })
  ])
})
