// Claude retrying a rate-limited request: the frames below follow Claude Code 2.1.280 against an
// HTTP 429 stub, captured with `--replay-user-messages --include-partial-messages`. The CLI writes
// only `api_retry` frames, and echoes the message only once a request gets through or is
// interrupted, so no turn opens: the send itself is all that says the session is working.

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function apiRetry(attempt: number, observedAt: number) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    observedAt,
    message: {
      type: 'system',
      subtype: 'api_retry',
      attempt,
      max_retries: 10,
      retry_delay_ms: 1_000 * 2 ** (attempt - 1),
      error_status: 429,
      error: 'rate_limit',
      uuid: `retry-${attempt}`,
      session_id: 'claude-session'
    }
  }
}

describe('Claude retrying a rate-limited request', () => {
  it('opens no turn while it retries', () => {
    const appended: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (identity, body) => appended.push({ identity, body }),
      appendTombstone: vi.fn(),
      publish: vi.fn()
    }
    const translator = createClaudeJournalTranslator({ sink })

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      translator.handle(apiRetry(attempt, 1_000 * attempt))
    }

    expect(appended.filter(({ body }) => readAgentJournalTurn(body) !== null)).toEqual([])
  })
})
