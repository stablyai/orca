import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { codexAuthenticationFailure } from './codex-authentication-failure'
import { codexTurnEndRejection, readCodexTurnEnd } from './codex-structured-turn-end-settlement'

const errors = [
  'unauthorized',
  ...[
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts'
  ].map((kind) => ({ [kind]: { httpStatusCode: 401 } }))
]
const detail = 'The session token has expired.'

describe('Codex protocol authentication failures', () => {
  it.each(errors)(
    'classifies the exact protocol kind %j on failure rows and rejected sends',
    (codexErrorInfo) => {
      const error = {
        codexErrorInfo,
        message: detail,
        additionalDetails: 'Sign in on the execution host.'
      }
      const bodies: AgentJournalItemBody[] = []
      const translator = createCodexJournalTranslator({
        primaryThreadId: () => 'thread',
        account: () => 'managed',
        sink: {
          appendItem: (_identity, body) => bodies.push(body),
          appendTombstone: () => {},
          publish: () => {}
        }
      })
      translator.handle({
        type: 'notification',
        sessionId: 'session',
        threadId: 'thread',
        method: 'error',
        params: { threadId: 'thread', turnId: 'turn', error, willRetry: false }
      })
      const row = bodies.find((body) => body.kind === 'status')
      expect(row).toMatchObject({
        failure: { kind: 'notSignedIn', account: 'managed', detail: { audience: 'person' } }
      })
      expect(row && 'text' in row ? row.text : '').toContain(detail)
      expect(row && 'text' in row ? row.text : '').toContain(
        'Sign in again in Codex Accounts settings.'
      )
      const end = readCodexTurnEnd('turn/completed', {
        turn: { id: 'turn', status: 'failed', error }
      })
      expect(end && codexTurnEndRejection(end, 'system')).toMatchObject({
        rejection: { kind: 'notSignedIn', account: 'system' }
      })
      expect(end && codexTurnEndRejection(end, 'system')?.reason).toContain('codex login')
      translator.dispose()
    }
  )
  it.each([
    'other',
    'unauthorized request',
    { other: { httpStatusCode: 401 } },
    { httpConnectionFailed: { httpStatusCode: 403 } },
    { httpConnectionFailed: { httpStatusCode: 500 } }
  ])('does not guess sign-out from unrelated failures %j', (codexErrorInfo) => {
    expect(
      codexAuthenticationFailure({
        error: { codexErrorInfo, message: '401 unauthorized authentication required' }
      })
    ).toBeNull()
  })
  it('keeps a retrying 401 as a retry, without asking the person to sign in yet', () => {
    const bodies: AgentJournalItemBody[] = []
    const translator = createCodexJournalTranslator({
      sink: {
        appendItem: (_identity, body) => bodies.push(body),
        appendTombstone: () => {},
        publish: () => {}
      }
    })
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method: 'error',
      params: { error: { codexErrorInfo: 'unauthorized', message: detail }, willRetry: true }
    })
    expect(bodies).toContainEqual(
      expect.objectContaining({ failure: expect.objectContaining({ kind: 'providerRetrying' }) })
    )
    translator.dispose()
  })
})
