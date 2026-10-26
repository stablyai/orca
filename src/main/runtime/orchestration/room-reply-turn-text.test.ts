import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { assistantTextForTurn } from './room-reply-turn-text'

const item = (
  body: AgentJournalRenderItem['body'],
  turnItemId?: string
): AgentJournalRenderItem => ({
  itemId: turnItemId ?? `item:${Math.random()}`,
  revision: 1,
  body,
  sequence: Math.random(),
  observedAt: 0,
  ...(turnItemId ? { turnScope: { kind: 'turn' as const, turnItemId } } : {})
})

describe('assistantTextForTurn', () => {
  it('finds assistant text through the turn record for provider completion ids', () => {
    const providerTurnId = 'provider-turn'
    const turnItemId = 'legacy-turn-item'
    const text = assistantTextForTurn(
      [
        item(
          { kind: 'turn', turnId: providerTurnId, state: 'completed', outcome: 'success' },
          turnItemId
        ),
        item(
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: '你好' }]
          },
          turnItemId
        )
      ],
      providerTurnId
    )
    expect(text).toBe('你好')
  })

  it('still supports older scopes that use the turn item id directly', () => {
    const text = assistantTextForTurn(
      [
        item(
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'ready' }]
          },
          'turn-item'
        )
      ],
      'turn-item'
    )
    expect(text).toBe('ready')
  })
})
