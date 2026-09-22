import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeTransientFailureJournal } from './claude-provider-transient-failure'

describe('Claude provider transient failure journal', () => {
  it('shows SDK-owned overload timing without dispatching another prompt', () => {
    const bodies: AgentJournalItemBody[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const journal = createClaudeTransientFailureJournal(sink, 'fixture')

    expect(
      journal.observeRetry(
        {
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 2_000,
          error_status: 529,
          error: 'overloaded'
        },
        Date.parse('2026-09-21T11:35:00.000Z')
      )
    ).toBe(true)

    expect(bodies).toEqual([
      expect.objectContaining({
        kind: 'status',
        presentation: 'provider-transient-failure',
        providerTransientFailure: {
          category: 'overloaded',
          code: '529',
          message: 'overloaded',
          retry: {
            state: 'active',
            attempt: 1,
            maxRetries: 3,
            nextRetryAt: Date.parse('2026-09-21T11:35:02.000Z')
          },
          recovery: { state: 'provider-retrying' }
        }
      })
    ])
  })
})
