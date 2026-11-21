import { describe, expect, it } from 'vitest'
import {
  agentSessionMessagePayload,
  agentSessionSendBodyFingerprint
} from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { SendBody } from '../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import {
  restartContinuationBody,
  restartContinuationEnvelope
} from './structured-agent-session-restart-continuation-envelope'

// A restart continuation names the work it resumes, so reply recovery can answer that work's Slack
// requests with it (design: slack-reply-lost-restart). Host-only: never sent to the agent, and a
// client's send can't carry it.

describe('restart continuation body', () => {
  it('names a restart offer’s work, and a cut turn named outright', () => {
    expect(restartContinuationBody({ work: { kind: 'turn', id: 'turn-1' } }).restartOf).toEqual({
      kind: 'turn',
      id: 'turn-1'
    })
    expect(
      restartContinuationBody({ work: { kind: 'submission', id: 'send-1' } }).restartOf
    ).toEqual({ kind: 'submission', id: 'send-1' })
    expect(
      restartContinuationBody({ restartOf: { kind: 'turn-item', id: 'item:turn-1' } }).restartOf
    ).toEqual({ kind: 'turn-item', id: 'item:turn-1' })
    expect(restartContinuationBody({})).not.toHaveProperty('restartOf')
  })

  it('keeps it out of what the agent gets and of the body fingerprint', () => {
    const { body } = restartContinuationEnvelope(
      'chat-1',
      1,
      { work: { kind: 'turn', id: 'turn-1' } },
      '1795203605251-0123456789abcdef0123456789abcdef'
    )
    expect(body.restartOf).toEqual({ kind: 'turn', id: 'turn-1' })
    expect(agentSessionMessagePayload(body)).not.toHaveProperty('restartOf')
    const { restartOf: _restartOf, ...plain } = body
    expect(agentSessionSendBodyFingerprint('chat-1', body)).toBe(
      agentSessionSendBodyFingerprint('chat-1', plain)
    )
  })

  it('is refused on a client’s send', () => {
    const sent = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'continue' }],
      restartOf: { kind: 'turn', id: 'turn-1' }
    }
    expect(SendBody.safeParse(sent).success).toBe(false)
  })
})
