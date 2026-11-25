import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { claudeAuthRetryStatus } from './claude-assistant-failures'

const SESSION = 'claude-session-1'

function claudeChat() {
  const items: AgentJournalRenderItem[] = []
  const journal = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body) => {
        const itemId = agentJournalItemKey(identity)
        const existing = items.find((item) => item.itemId === itemId)
        if (existing) {
          existing.body = body
        } else {
          items.push({ itemId, sequence: items.length + 1, revision: 1, observedAt: 1_000, body })
        }
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const send = (message: Record<string, unknown>, startsTurn?: true) =>
    journal.handle({
      type: 'message',
      sessionId: 'orca',
      observedAt: 1_000,
      message: { session_id: SESSION, parent_tool_use_id: null, ...message },
      ...(startsTurn ? { startsTurn } : {})
    })
  send(
    {
      type: 'user',
      uuid: 'prompt-1',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    },
    true
  )
  return { items, send }
}

// Claude refreshes the login before attempt 2; a 401 still retried at attempt 3 is the blind loop.
const retry = (status: number, attempt = 3) => ({
  type: 'system',
  subtype: 'api_retry',
  attempt,
  max_retries: 10,
  error_status: status,
  error: 'authentication_failed'
})

// The result Claude ends a turn with once Orca interrupts it.
const interrupted = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
  num_turns: 1
}

const turnOutcome = (items: AgentJournalRenderItem[]) =>
  items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)?.outcome
const failureKinds = (items: AgentJournalRenderItem[]) =>
  items.flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error'
      ? [readAgentSessionFailureFact('failure' in item.body ? item.body.failure : undefined)?.kind]
      : []
  )

it('ends a turn Orca interrupted on a 401 retry as a sign-in failure', () => {
  const { items, send } = claudeChat()
  send(retry(401))
  send(interrupted)
  expect(failureKinds(items)).toEqual(['notSignedIn'])
  expect(turnOutcome(items)).toBe('failure')
})

it('leaves a turn whose retries were for a temporary error as Claude ended it', () => {
  const { items, send } = claudeChat()
  send(retry(529))
  send(interrupted)
  expect(failureKinds(items)).toEqual([])
  expect(turnOutcome(items)).toBe('cancellation')
})

it("never fails a later turn with an earlier turn's credential retry", () => {
  const { items, send } = claudeChat()
  send(retry(401))
  // The turn ends on idle, with no result to read the retry.
  send({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  send(
    {
      type: 'user',
      uuid: 'prompt-2',
      message: { role: 'user', content: [{ type: 'text', text: 'again' }] }
    },
    true
  )
  send(interrupted)
  expect(failureKinds(items)).toEqual([])
})

it("leaves Claude its own login refresh: a 401 is stopped only once it outlives Claude's refresh", () => {
  expect(claudeAuthRetryStatus(retry(401, 1))).toBeNull()
  expect(claudeAuthRetryStatus(retry(401, 2))).toBeNull()
  expect(claudeAuthRetryStatus(retry(401, 3))).toBe(401)
  expect(claudeAuthRetryStatus(retry(403, 1))).toBe(403)
})

it("words a later turn's own sign-in failure, not an earlier turn's denial", () => {
  const { items, send } = claudeChat()
  send(retry(403))
  send({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  send(
    {
      type: 'user',
      uuid: 'prompt-2',
      message: { role: 'user', content: [{ type: 'text', text: 'again' }] }
    },
    true
  )
  // Claude's own verdict on a dead login, as it streams it.
  send({
    type: 'assistant',
    error: 'authentication_failed',
    api_error_status: 401,
    uuid: 'assistant-2',
    message: {
      id: 'msg_2',
      role: 'assistant',
      model: '<synthetic>',
      content: [
        {
          type: 'text',
          text: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.'
        }
      ]
    }
  })
  expect(failureKinds(items)).toEqual(['notSignedIn'])
})

it('fails an interrupted turn whose sign-in notice Claude wrote before the result', () => {
  const { items, send } = claudeChat()
  send(retry(401))
  send({
    type: 'assistant',
    error: 'authentication_failed',
    api_error_status: 401,
    uuid: 'assistant-1',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: 'Failed to authenticate. API Error: 401' }]
    }
  })
  send(interrupted)
  expect(failureKinds(items)).toEqual(['notSignedIn'])
  expect(turnOutcome(items)).toBe('failure')
})
