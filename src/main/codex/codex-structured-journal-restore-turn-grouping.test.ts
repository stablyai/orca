import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { nativeChatTurnFold } from '../../shared/native-chat-turn-fold'
import { nativeChatRowTurnKeys } from '../../shared/native-chat-turn-grouping'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../shared/structured-agent-session-projection'
import { selectStructuredAgentTurnBars } from '../../shared/structured-agent-session-turn-timing'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const THREAD_ID = 'thread-abc'

function historicalTurn(index: number): Record<string, unknown> {
  const id = `turn-${index}`
  return {
    id,
    status: 'completed',
    startedAt: 1_700_000_000 + index * 100,
    completedAt: 1_700_000_050 + index * 100,
    items: [
      {
        type: 'userMessage',
        id: `user-${index}`,
        content: [{ type: 'text', text: `ask ${index}` }]
      },
      { type: 'agentMessage', id: `interim-${index}`, text: `looking ${index}` },
      { type: 'agentMessage', id: `answer-${index}`, text: `answer ${index}` }
    ]
  }
}

/** What the journal hands a reader after a restore: rows in append order. */
function restoredJournal(turnCount: number): AgentJournalRenderItem[] {
  const items: AgentJournalRenderItem[] = []
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (identity, body) => {
        const sequence = items.length + 1
        items.push({
          itemId: agentJournalItemKey(identity),
          revision: 1,
          body,
          sequence,
          observedAt: sequence
        })
      },
      appendTombstone: () => {},
      publish: () => {}
    },
    sessionId: 'session-1',
    primaryThreadId: () => THREAD_ID
  })
  const turns = Array.from({ length: turnCount }, (_, index) => historicalTurn(index + 1))
  expect(translator.restoreThread(THREAD_ID, { turns })).toEqual({ accepted: true })
  return items
}

describe('grouping a Codex thread restored from full history', () => {
  it('keeps each turn with its own rows and folds each to its own answer', () => {
    const items = restoredJournal(3)
    const bars = selectStructuredAgentTurnBars(items, [], null)
    const messages = items
      .map(projectStructuredItemToNativeChat)
      .filter((message): message is NativeChatMessage => message !== null)
    const turnKeys = nativeChatRowTurnKeys(messages, bars.turnKeysByItemId)
    const opener = (index: number): string => `codex:${THREAD_ID}:turn-${index}:0`

    expect(messages.map((message, index) => [message.role, turnKeys[index]])).toEqual([
      ['user', opener(1)],
      ['assistant', opener(1)],
      ['assistant', opener(1)],
      ['user', opener(2)],
      ['assistant', opener(2)],
      ['assistant', opener(2)],
      ['user', opener(3)],
      ['assistant', opener(3)],
      ['assistant', opener(3)]
    ])
    expect([...bars.settledTurns.keys()]).toEqual([opener(1), opener(2), opener(3)])

    const { foldedRows } = nativeChatTurnFold({
      rows: messages.map((message, index) => ({
        turnKey: turnKeys[index],
        role: message.role,
        rendersProse: true,
        outlivesTurn: false,
        reportsFailure: false
      })),
      settledTurnKeys: new Set(bars.settledTurns.keys()),
      expandedTurnKeys: new Set()
    })
    const visible = messages.filter((_, index) => !foldedRows.has(index))
    expect(visible.map((message) => message.blocks)).toEqual(
      ['ask 1', 'answer 1', 'ask 2', 'answer 2', 'ask 3', 'answer 3'].map((text) => [
        { type: 'text', text }
      ])
    )
  })
})
