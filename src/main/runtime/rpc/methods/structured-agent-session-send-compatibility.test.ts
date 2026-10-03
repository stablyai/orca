// Which clients get a send answered at acceptance, and which have their reply held until the
// message is handed over: a client that cannot show a rejection after `pending` must not see one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  sendParams,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

beforeEach(() => {
  installStructuredHostStub()
})

afterEach(() => {
  clearStructuredHostStub()
})

describe('agentSession.send reply timing', () => {
  it('holds a pending reply until handover for a client that cannot show a later rejection', async () => {
    hostCalls.send.mockResolvedValueOnce(pendingSendResult())
    hostCalls.waitForSendSettlement.mockResolvedValueOnce(undefined)

    await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)

    expect(hostCalls.waitForSendSettlement).toHaveBeenCalledWith(SESSION, 'client-1', {
      until: 'handed-over-or-behind-command',
      budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
    })
  })

  it("marks a client's send as the user's own, which alone lifts a Stop's queue pause", async () => {
    hostCalls.send.mockResolvedValueOnce(pendingSendResult())
    await call('agentSession.send', sendParams(), STRUCTURED_CLIENT)
    expect(hostCalls.send.mock.calls[0]?.[1]).toMatchObject({ userSend: true })
  })

  it('answers at acceptance for the local desktop and paired desktop clients (W2)', async () => {
    for (const clientCapabilities of [
      DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
      // A paired desktop gains the structured surface as its own capability; the reply rule rides
      // on the list it already sends.
      [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    ]) {
      hostCalls.send.mockResolvedValueOnce(pendingSendResult())
      const response = await call('agentSession.send', sendParams(), {
        clientKind: 'runtime',
        clientCapabilities: [...clientCapabilities]
      })
      expect(response).toMatchObject({
        ok: true,
        result: { value: { submission: { dispatchState: 'pending' } } }
      })
    }
    expect(hostCalls.waitForSendSettlement).not.toHaveBeenCalled()
  })
})

describe('a send that arrives before the host is built', () => {
  it('builds the host and is answered by it, rather than refused', async () => {
    clearStructuredHostStub()
    hostCalls.send?.mockReset()
    const ensureStructuredAgentSessionHost = vi.fn(async () => installStructuredHostStub())

    const response = await call('agentSession.send', sendParams(), STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost
    })

    expect(ensureStructuredAgentSessionHost).toHaveBeenCalledOnce()
    expect(response).not.toMatchObject({ ok: false })
    expect(hostCalls.send).toHaveBeenCalledOnce()
  })

  it.each([
    ['agentSession.queuedMessageSend', 'queuedMessageSend', { messageId: 'message-1' }],
    ['agentSession.queuedMessageDelete', 'queuedMessageDelete', { messageId: 'message-1' }],
    ['agentSession.queuedMessagesResume', 'queuedMessagesResume', {}],
    ['agentSession.threadGoal', 'changeThreadGoal', { change: { kind: 'clear' } }]
  ])('builds the host for %s too, and is answered by it', async (method, hostMethod, fields) => {
    clearStructuredHostStub()
    const answered = vi.fn(async () => ({ ok: true, replayed: false }))
    const ensureStructuredAgentSessionHost = vi.fn(async () => {
      installStructuredHostStub()
      hostCalls[hostMethod] = answered
    })

    const response = await call(method, { envelope: envelope(), ...fields }, STRUCTURED_CLIENT, {
      ensureStructuredAgentSessionHost
    })

    expect(ensureStructuredAgentSessionHost).toHaveBeenCalledOnce()
    expect(response).not.toMatchObject({ ok: false })
    expect(answered).toHaveBeenCalledOnce()
  })
})

function pendingSendResult() {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-a', sequence: 1 },
    value: {
      clientMessageId: 'client-1',
      submission: {
        clientMessageId: 'client-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null,
        handoverRecorded: true as const
      }
    }
  }
}
