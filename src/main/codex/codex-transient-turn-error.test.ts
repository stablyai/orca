import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { codexTransientTurnError } from './codex-transient-turn-error'

function rows(info: unknown = 'serverOverloaded'): AgentJournalRenderItem[] {
  const payload = JSON.stringify({
    turnId: 'provider-turn',
    willRetry: false,
    error: {
      message: 'Selected model is at capacity. Please try a different model.',
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
      const r = rows()
      change(r)
      expect(codexTransientTurnError(r, 'turn')).toBeNull()
    }
  })
})
