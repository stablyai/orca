import { describe, expect, it } from 'vitest'
import type { AgentMessageSource } from '../../../src/shared/agent-session-message-source'
import { agentMessageAttribution } from './mobile-agent-message-attribution'
import { mobileQueuedMessageCards } from './mobile-structured-queued-message-cards'

function from(names: (string | null)[]): AgentMessageSource {
  return {
    kind: 'agent',
    senders: names.map((name, index) => ({
      party: { address: `term_${index}`, terminalHandle: `term_${index}`, orcaSessionId: null },
      name
    })),
    orchestration: null
  }
}

describe('who another agent’s message is from, on mobile', () => {
  it('names nothing on the person’s own message', () => {
    expect(agentMessageAttribution('From', undefined)).toBeNull()
  })

  it('names each sender, an unnamed one as an agent, and counts the rest', () => {
    expect(agentMessageAttribution('Message from', from(['Coder']))).toBe('Message from Coder')
    expect(agentMessageAttribution('From', from([]))).toBe('From an agent')
    expect(agentMessageAttribution('From', from(['A', 'B', 'C', 'D']))).toBe('From A, B, C +1')
  })

  it('keeps two senders that share a name two, and counts only the senders it leaves out', () => {
    expect(agentMessageAttribution('From', from(['Codex', 'Codex']))).toBe('From Codex, Codex')
    expect(agentMessageAttribution('From', from([null, null]))).toBe('From an agent, an agent')
    expect(agentMessageAttribution('From', from(['Codex', 'Codex', 'Codex', 'Codex']))).toBe(
      'From Codex, Codex, Codex +1'
    )
  })

  it('puts the line on the queued card, read through the shared reader', () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'You have 1 orchestration message.' }]
    }
    const cards = mobileQueuedMessageCards(
      [
        {
          messageId: 'agent',
          position: 1,
          state: 'waiting',
          body: { ...body, from: from(['Coder']) }
        },
        { messageId: 'person', position: 2, state: 'waiting', body }
      ],
      [],
      { pendingPrompt: false }
    )
    expect(cards.map((card) => card.attribution)).toEqual(['From Coder', null])
  })
})
