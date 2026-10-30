import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { codexTransientTurnError } from './codex-transient-turn-error'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'

function rows(
  info: unknown = 'serverOverloaded',
  message = 'Selected model is at capacity. Please try a different model.'
): AgentJournalRenderItem[] {
  const payload = JSON.stringify({
    turnId: 'provider-turn',
    willRetry: false,
    error: {
      message,
      codexErrorInfo: info
    }
  })
  return [
    {
      itemId: 'turn-row',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'turn',
        turnId: 'turn',
        providerTurnId: 'provider-turn',
        state: 'completed',
        outcome: 'failure'
      }
    },
    {
      itemId: 'error-row',
      revision: 0,
      sequence: 2,
      observedAt: 2,
      turnScope: { kind: 'turn', turnItemId: 'turn-row' },
      body: {
        kind: 'status',
        text: 'error',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:error',
          payload: { head: payload, byteLength: payload.length, digest: 'digest', truncated: false }
        }
      }
    }
  ]
}

describe('Codex transient turn failures', () => {
  it.each([
    'serverOverloaded',
    'internalServerError',
    'httpConnectionFailed',
    { responseStreamDisconnected: { httpStatusCode: 502 } },
    { responseStreamConnectionFailed: { httpStatusCode: null } }
  ])('accepts a native temporary error: %j', (info) => {
    expect(codexTransientTurnError(rows(info), 'turn')).toBeTruthy()
  })
  it.each(['serverOverloaded', 'other'])(
    'accepts a live native lifecycle turn without a command ID: %s',
    (info) => {
      const r = rows(info, 'stream disconnected before completion: stream closed')
      const nativeTurnId = 'provider-turn'
      r[0]!.itemId = agentJournalItemKey({
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session',
        recordId: `turn-lifecycle:${nativeTurnId}`
      })
      r[0]!.body = {
        kind: 'turn',
        turnId: nativeTurnId,
        state: 'completed',
        outcome: 'failure'
      }
      r[1]!.turnScope = { kind: 'turn', turnItemId: r[0]!.itemId }
      expect(codexTransientTurnError(r, nativeTurnId)).toBe(info)
      r[0]!.recovered = true
      expect(codexTransientTurnError(r, nativeTurnId)).toBeNull()
    }
  )
  it('does not treat an unclaimed Orca turn ID as a native provider turn ID', () => {
    const r = rows()
    r[0]!.body = {
      kind: 'turn',
      turnId: 'provider-turn',
      state: 'completed',
      outcome: 'failure'
    }
    expect(codexTransientTurnError(r, 'provider-turn')).toBeNull()
  })

  it.each([
    'stream disconnected before completion: stream closed before response.completed',
    'stream disconnected before completion: error sending request for url (http://127.0.0.1:9/v1/responses)'
  ])('accepts a terminal native other stream disconnection: %s', (message) => {
    expect(codexTransientTurnError(rows('other', message), 'turn')).toBe('other')
  })
  it.each([
    [502, 'other'],
    [401, null],
    [429, null],
    ['502', null]
  ])('checks the HTTP status of an other stream disconnection: %s', (status, expected) => {
    expect(
      codexTransientTurnError(
        rows(
          { other: { httpStatusCode: status } },
          'stream disconnected before completion: closed'
        ),
        'turn'
      )
    ).toBe(expected)
  })

  it.each([
    { message: 'Quoted: stream disconnected before completion: stream closed' },
    { message: '"stream disconnected before completion: stream closed"' },
    { message: 'other error', additionalDetails: 'stream disconnected before completion: closed' },
    { message: { text: 'stream disconnected before completion: closed' } }
  ])('rejects other errors without an own stream-disconnection message: %j', (error) => {
    const r = rows('other')
    const body = r[1]!.body
    if (body.kind === 'status') {
      body.providerFrame!.payload.head = JSON.stringify({
        turnId: 'provider-turn',
        willRetry: false,
        error: { codexErrorInfo: 'other', ...error }
      })
    }
    expect(codexTransientTurnError(r, 'turn')).toBeNull()
  })

  it.each([
    'usageLimitExceeded',
    'unauthorized',
    'contextWindowExceeded',
    'other',
    { responseStreamDisconnected: { httpStatusCode: 401 } },
    { httpConnectionFailed: { httpStatusCode: 429 } }
  ])('does not infer retryability from the message: %j', (info) => {
    expect(codexTransientTurnError(rows(info), 'turn')).toBeNull()
  })

  it('ignores quotations, children, old turns, truncated frames and still-running turns', () => {
    for (const change of [
      (r: AgentJournalRenderItem[]) => {
        r[1]!.body = {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Selected model is at capacity' }]
        }
      },
      (r: AgentJournalRenderItem[]) => {
        r[1]!.agentId = 'child'
      },
      (r: AgentJournalRenderItem[]) => {
        r[1]!.recovered = true
      },
      (r: AgentJournalRenderItem[]) => {
        const body = r[1]!.body
        if (body.kind === 'status') {
          body.providerFrame!.payload.head = body.providerFrame!.payload.head.replace(
            '"turnId":"provider-turn"',
            '"turnId":"another-provider-turn"'
          )
        }
      },
      (r: AgentJournalRenderItem[]) => {
        r[1]!.turnScope = { kind: 'turn', turnItemId: 'old-turn' }
      },
      (r: AgentJournalRenderItem[]) => {
        const b = r[1]!.body
        if (b.kind === 'status') {
          b.providerFrame!.payload.truncated = true
        }
      },
      (r: AgentJournalRenderItem[]) => {
        const b = r[0]!.body
        if (b.kind === 'turn') {
          b.state = 'running'
        }
      },
      (r: AgentJournalRenderItem[]) => {
        const b = r[1]!.body
        if (b.kind === 'status') {
          b.providerFrame!.payload.head = b.providerFrame!.payload.head.replace(
            '"willRetry":false',
            '"willRetry":true'
          )
        }
      }
    ]) {
      for (const r of [
        rows(),
        rows('other', 'stream disconnected before completion: stream closed')
      ]) {
        change(r)
        expect(codexTransientTurnError(r, 'turn')).toBeNull()
      }
    }
  })
})
