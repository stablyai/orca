import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { withStructuredSessionContinuation } from './structured-agent-session-continuation'

function snapshot(items: AgentJournalSnapshot['items']): AgentJournalSnapshot {
  return {
    sessionId: 'session-1',
    cursor: { epoch: 'e1', sequence: items.length },
    items,
    submissions: []
  }
}

describe('withStructuredSessionContinuation', () => {
  it('treats the ready status as the switch boundary without colliding with the switching status', () => {
    const switching = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: 'provider-switch:8'
    })
    const ready = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: 'provider-switch-ready:8'
    })
    const prior = agentJournalItemKey({ provider: 'orca', clientMessageId: 'prior' })
    // Sits between the two status items, so only the ready boundary captures it.
    const midSwitch = agentJournalItemKey({ provider: 'orca', clientMessageId: 'mid-switch' })
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'continue' }]
    }
    const result = withStructuredSessionContinuation(
      snapshot([
        {
          itemId: prior,
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Remember the blue widget' }]
          }
        },
        {
          itemId: switching,
          revision: 1,
          sequence: 2,
          observedAt: 2,
          body: { kind: 'status', text: 'Switching to Claude.' }
        },
        {
          itemId: midSwitch,
          revision: 1,
          sequence: 3,
          observedAt: 3,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Carrying the widget across' }]
          }
        },
        {
          itemId: ready,
          revision: 1,
          sequence: 4,
          observedAt: 4,
          body: { kind: 'status', text: 'Now talking to Claude.' }
        }
      ]),
      'next',
      body
    )
    expect(JSON.stringify(result)).toContain('Remember the blue widget')
    expect(JSON.stringify(result)).toContain('Carrying the widget across')
    expect(result.blocks.at(-1)).toEqual(body.blocks[0])
  })
})
