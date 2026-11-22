import { afterEach, describe, expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const lanes = new Set<AcpTimelineTranslator>()

afterEach(() => {
  for (const lane of lanes) {
    lane.dispose()
  }
  lanes.clear()
})

function open(dialect: AcpDialect) {
  const lane = new AcpTimelineTranslator({ sessionId: 'session', dialect })
  lanes.add(lane)
  lane.openPrompt('request', 1_000)
  return lane
}

function retry(attempt: number): SessionUpdate {
  return {
    sessionUpdate: 'session_info_update',
    _meta: {
      'opencode/retry': {
        attempt,
        nextRetryAt: '2026-11-22T00:01:00.000Z',
        error: {
          type: 'provider.rate-limit',
          message: 'Rate limit reached; retrying shortly.',
          status: 429,
          retryAfterMs: 60_000,
          response: { body: 'synthetic private response' }
        }
      }
    }
  }
}

function notify(lane: AcpTimelineTranslator, update: SessionUpdate) {
  return lane.notification('session/update', { sessionId: 'session', update }, 1_100)
}

describe('ACP provider retry feedback', () => {
  it('shows OpenCode retry facts and starts a new notice after the provider clears its retry', () => {
    const lane = open(OPENCODE_ACP_DIALECT)
    const first = notify(lane, retry(3))[0]
    expect(first).toMatchObject({
      type: 'item.update',
      body: {
        kind: 'status',
        tone: 'warning',
        failure: {
          kind: 'providerRetrying',
          retry: {
            attempt: 3,
            error: 'provider.rate-limit',
            status: 429,
            cause: 'Rate limit reached; retrying shortly.'
          }
        }
      },
      join: { thread: 'session', turn: 'prompt:request' }
    })
    const next = notify(lane, retry(4))[0]
    if (first?.type !== 'item.update' || next?.type !== 'item.update') {
      throw new Error('Expected retry notices')
    }
    expect(next.item).toBe(first.item)
    expect(next.body).toMatchObject({ failure: { retry: { attempt: 4 } } })
    expect(JSON.stringify(next)).not.toContain('synthetic private response')
    expect(
      notify(lane, { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } })
    ).toEqual([])
    const following = notify(lane, retry(1))[0]
    if (following?.type !== 'item.update') {
      throw new Error('Expected a new retry notice')
    }
    expect(following.item).not.toBe(first.item)
    expect(following.body).toMatchObject({ failure: { retry: { attempt: 1 } } })
    expect(lane.promptResult('request', { stopReason: 'end_turn' }, 1_200)).toContainEqual(
      expect.objectContaining({ type: 'turn.end', outcome: 'success' })
    )
  })

  it('ignores other sessions, replayed retries, malformed markers and ordinary session info', () => {
    const lane = open(OPENCODE_ACP_DIALECT)
    expect(
      lane.notification('session/update', { sessionId: 'other', update: retry(1) }, 1_100)
    ).toEqual([])
    expect(
      lane.notification(
        'session/update',
        { sessionId: 'session', _meta: { isReplay: true }, update: retry(1) },
        1_100
      )
    ).toEqual([])
    expect(notify(lane, retry(-1))).toEqual([])
    expect(notify(lane, { sessionUpdate: 'session_info_update', title: 'Updated title' })).toEqual(
      []
    )
  })

  it('retains Antigravity text retries and passes ordinary assistant text through', () => {
    const lane = open(ANTIGRAVITY_ACP_DIALECT)
    const notice: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\u26a0 Model produced invalid output.' }
    }
    expect(notify(lane, notice)[0]).toMatchObject({
      type: 'item.update',
      body: {
        failure: {
          kind: 'providerRetrying',
          retry: { cause: 'Model produced invalid output.', attempt: 1 }
        }
      }
    })
    expect(notify(lane, notice)[0]).toMatchObject({
      body: { failure: { retry: { attempt: 2 } } }
    })
    expect(
      notify(lane, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done' }
      })
    ).toContainEqual(expect.objectContaining({ type: 'text.delta', text: 'Done' }))
  })
})
