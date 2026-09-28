// Which clients get a send answered at acceptance, and which have their reply held until the
// message is handed over: a client that cannot show a rejection after `pending` must not see one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_START_WAIT_MS } from '../../../native-chat/agent-session-wire/structured-agent-session-send-settlement'
import {
  call,
  clearStructuredHostStub,
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
      until: 'handed-over',
      budgetMs: STRUCTURED_AGENT_SESSION_START_WAIT_MS
    })
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
