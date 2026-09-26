// Admission can be revoked while sessions are still open: the host setting is turned off with a
// chat already on screen. What the caller may still do to that chat is the rule this suite pins.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  ADMISSION_METHODS,
  CLEANUP_METHODS
} from './structured-agent-session-gate-classification.test-fixture'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('admission revoked while a session is still open', () => {
  // The host setting is admission control. Turning it off must not strand a chat that was opened
  // while it was on: the pane is still mounted, so its close has to land.
  const SETTING_OFF = { getClientSettings: () => ({ experimentalStructuredNativeChat: false }) }

  it.each(CLEANUP_METHODS)(
    'still serves $method after the host setting is turned off',
    async ({ method, params, hostCall }) => {
      const response = await call(method, params, STRUCTURED_CLIENT, SETTING_OFF)

      expect(response).toMatchObject({ ok: true })
      // `unsubscribe` retires runtime-owned subscriptions rather than calling the host, so its
      // result payload is the observable effect.
      if (hostCall === 'unsubscribe') {
        expect(response).toMatchObject({ result: { unsubscribed: true } })
      } else {
        expect(hostCalls[hostCall]).toHaveBeenCalled()
      }
    }
  )

  it('stops the provider child when closing a chat the setting no longer admits', async () => {
    const response = await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT, {
      ...SETTING_OFF
    })

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
    // The durable tab has to be retired too, or the chat comes back on the next sync.
    expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledWith(SESSION, false)
  })

  it('cancels an in-flight turn the setting no longer admits', async () => {
    const response = await call(
      'agentSession.cancel',
      { envelope: envelope(), turnId: 'turn-1' },
      STRUCTURED_CLIENT,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.cancel).toHaveBeenCalledOnce()
  })

  it.each(['runtime', 'mobile'] as const)(
    'lets a %s client close a chat it already owns',
    async (clientKind) => {
      const response = await call(
        'agentSession.close',
        { sessionId: SESSION },
        { clientKind, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] },
        SETTING_OFF
      )

      expect(response).toMatchObject({ ok: true })
      expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
    }
  )

  it('lets an in-process caller close, which is how terminal disposal retires a chat', async () => {
    const response = await call(
      'agentSession.close',
      { sessionId: SESSION },
      undefined,
      SETTING_OFF
    )

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
  })

  it.each(ADMISSION_METHODS)(
    'keeps $method refused once the setting is off',
    async ({ method, params }) => {
      const response = await call(method, params, STRUCTURED_CLIENT, SETTING_OFF)

      // Asserting the gate's own code, not merely `ok: false`: a params-validation failure would
      // pass a bare falsy check and hide a gate that had stopped refusing.
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
    }
  )
})
