// Chat UI can be turned off with chats already open. It decides how NEW agent launches open, so the
// methods that create a session refuse; every method on a session that already exists keeps working.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  CLEANUP_METHODS,
  CREATE_METHODS,
  EXISTING_SESSION_METHODS
} from './structured-agent-session-gate-classification.test-fixture'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  hostStub,
  installStructuredHostStub,
  sendParams,
  SESSION,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

const CHAT_UI_OFF = { getClientSettings: () => ({ experimentalNativeChat: false }) }
const GATE_REFUSAL = 'structured_agent_session_unsupported'

describe('Chat UI turned off with a session still open', () => {
  it.each(CLEANUP_METHODS)('still serves $method', async ({ method, params, hostCall }) => {
    const response = await call(method, params, STRUCTURED_CLIENT, CHAT_UI_OFF)

    expect(response).toMatchObject({ ok: true })
    // `unsubscribe` retires runtime-owned subscriptions rather than calling the host, so its
    // result payload is the observable effect.
    if (hostCall === 'unsubscribe') {
      expect(response).toMatchObject({ result: { unsubscribed: true } })
    } else {
      expect(hostCalls[hostCall]).toHaveBeenCalled()
    }
  })

  it.each(EXISTING_SESSION_METHODS)(
    'is never refused by the gate for $method',
    async ({ method, params }) => {
      const response = await call(method, params, STRUCTURED_CLIENT, CHAT_UI_OFF)

      // The stub host does not implement every method, so a non-gate error is allowed here; the
      // gate's own code is what must be absent.
      if (!response.ok) {
        expect(response.error.message).not.toContain(GATE_REFUSAL)
      }
    }
  )

  it.each([STRUCTURED_CLIENT, STRUCTURED_MOBILE_CLIENT])(
    'sends into an open chat from a $clientKind client',
    async (client) => {
      const response = await call('agentSession.send', sendParams(), client, CHAT_UI_OFF)

      expect(response).toMatchObject({ ok: true })
      expect(hostCalls.send).toHaveBeenCalledTimes(1)
    }
  )

  it('reads history and answers a prompt in an open chat', async () => {
    const history = await call(
      'agentSession.history',
      { sessionId: SESSION, direction: 'tail' },
      STRUCTURED_CLIENT,
      CHAT_UI_OFF
    )
    const answer = await call(
      'agentSession.respondToApproval',
      { envelope: envelope(), itemId: 'item-1', expectedRevision: 1, optionId: 'allow' },
      STRUCTURED_CLIENT,
      CHAT_UI_OFF
    )

    expect(history).toMatchObject({ ok: true })
    expect(answer).toMatchObject({ ok: true })
    expect(hostCalls.respondToPrompt).toHaveBeenCalledOnce()
  })

  it('still offers and resumes the chats that were working at the last quit', async () => {
    const list = vi.fn(async () => [{ sessionId: SESSION }])
    const continueAfterRestart = vi.fn(async () => ({ results: [] }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart methods read only restartResume; every other member is the shared stub's.
    const host = {
      ...hostStub(),
      restartResume: { list, listFailures: vi.fn(async () => []), continueAfterRestart }
    } as unknown as StructuredAgentSessionHost
    setStructuredAgentSessionHost(host)

    const offered = await call('agentSession.restartResumable', {}, STRUCTURED_CLIENT, CHAT_UI_OFF)
    const resumed = await call(
      'agentSession.restartContinue',
      { sessionIds: [SESSION] },
      STRUCTURED_CLIENT,
      CHAT_UI_OFF
    )

    expect(offered).toMatchObject({ ok: true, result: { sessions: [{ sessionId: SESSION }] } })
    expect(resumed).toMatchObject({ ok: true })
    expect(continueAfterRestart).toHaveBeenCalledWith([SESSION], expect.any(String))
  })

  it('stops the provider child and retires the tab when closing the chat', async () => {
    const response = await call(
      'agentSession.close',
      { sessionId: SESSION },
      STRUCTURED_CLIENT,
      CHAT_UI_OFF
    )

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
    // The durable tab has to be retired too, or the chat comes back on the next sync.
    expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledWith(SESSION, false)
  })

  it.each(['runtime', 'mobile'] as const)(
    'lets a %s client close an open chat',
    async (clientKind) => {
      const response = await call(
        'agentSession.close',
        { sessionId: SESSION },
        { clientKind, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] },
        CHAT_UI_OFF
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
      CHAT_UI_OFF
    )

    expect(response).toMatchObject({ ok: true })
    expect(hostCalls.close).toHaveBeenCalledWith(SESSION)
  })

  it.each(CREATE_METHODS)(
    'refuses $method, which would start a new chat',
    async ({ method, params }) => {
      const response = await call(method, params, STRUCTURED_CLIENT, CHAT_UI_OFF)

      // Asserting the gate's own code, not merely `ok: false`: a params-validation failure would
      // pass a bare falsy check and hide a gate that had stopped refusing.
      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(GATE_REFUSAL) }
      })
      expect(hostCalls.attach).not.toHaveBeenCalled()
    }
  )

  it.each(CREATE_METHODS)(
    'refuses $method from an in-process caller too',
    async ({ method, params }) => {
      const response = await call(method, params, undefined, CHAT_UI_OFF)

      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(GATE_REFUSAL) }
      })
    }
  )
})

describe('Chat UI on', () => {
  it.each(CREATE_METHODS)('admits $method for a capable client', async ({ method, params }) => {
    const response = await call(method, params, STRUCTURED_CLIENT)

    if (!response.ok) {
      expect(response.error.message).not.toContain(GATE_REFUSAL)
    }
  })

  it.each(CREATE_METHODS)(
    'still refuses $method to a client without the capability',
    async ({ method, params }) => {
      const response = await call(method, params, { clientKind: 'mobile', clientCapabilities: [] })

      expect(response).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(GATE_REFUSAL) }
      })
    }
  )
})
