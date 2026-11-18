import { describe, expect, it } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import { mobileQueuedMessageCards } from './queued-messages/mobile-structured-queued-message-cards'

function draft(overrides: Partial<AgentSessionQueuedMessage> & { messageId: string }) {
  return {
    position: 1,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: `body of ${overrides.messageId}` }]
    },
    state: 'waiting' as const,
    ...overrides
  }
}

describe('mobileQueuedMessageCards', () => {
  it("leaves out a setup card's answer while it waits", () => {
    const answer = draft({
      messageId: 'answer',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Card google-setup/services answered: gmail' }],
        origin: 'card-answer'
      }
    })
    const typed = draft({ messageId: 'typed', position: 2 })
    expect(mobileQueuedMessageCards([answer, typed], []).map((card) => card.messageId)).toEqual([
      'typed'
    ])
  })
})
