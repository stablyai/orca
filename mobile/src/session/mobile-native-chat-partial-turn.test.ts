import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { selectStructuredAgentTurnBars } from '../../../src/shared/structured-agent-session-turn-timing'
import { nativeChatTurnMembership } from '../../../src/shared/native-chat-turn-membership'
import { mobileNativeChatTurnFold } from './mobile-native-chat-turn-fold'

it('folds a completed long-turn tail when its lifecycle and opening prompt are outside the window', () => {
  const items: AgentJournalRenderItem[] = [
    {
      itemId: 'progress',
      sequence: 400,
      revision: 1,
      observedAt: 1000,
      turnScope: { kind: 'turn', turnItemId: 'turn' },
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Intermediate progress' }]
      }
    },
    {
      itemId: 'tool',
      sequence: 401,
      revision: 1,
      observedAt: 1001,
      turnScope: { kind: 'turn', turnItemId: 'turn' },
      body: {
        kind: 'tool-call',
        name: 'exec_command',
        input: { command: 'pwd' },
        state: 'completed'
      }
    },
    {
      itemId: 'answer',
      sequence: 402,
      revision: 1,
      observedAt: 1002,
      turnScope: { kind: 'turn', turnItemId: 'turn' },
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Final answer' }] }
    }
  ]
  const latestTurn = {
    itemId: 'turn',
    observedAt: 2000,
    turn: {
      turnId: 'provider-turn',
      state: 'completed' as const,
      userItemId: 'unloaded-user',
      startedAt: 500,
      completedAt: 2000,
      durationMs: 1500
    }
  }
  const messages = projectStructuredAgentSessionMessages(items, [], [])
  const membership = nativeChatTurnMembership(messages, { items, submissions: [], latestTurn })
  const timing = selectStructuredAgentTurnBars(items, [], null, latestTurn)
  const completed = Object.fromEntries(
    [...timing.settledTurns].flatMap(([key, value]) =>
      value ? [[key, { ...value, thinking: false }]] : []
    )
  )
  const fold = mobileNativeChatTurnFold(messages, membership.turnKeys, completed, new Set())
  expect(messages.filter((_, index) => !fold.foldedRows.has(index)).map((row) => row.id)).toEqual([
    'answer'
  ])
  const expanded = mobileNativeChatTurnFold(
    messages,
    membership.turnKeys,
    completed,
    new Set(['turn'])
  )
  expect(expanded.foldedRows.size).toBe(0)
  expect(messages.some((row) => row.blocks.some((block) => block.type === 'tool-call'))).toBe(true)
})
