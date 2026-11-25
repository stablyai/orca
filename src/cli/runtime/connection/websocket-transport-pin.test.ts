import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRemoteRuntimeRequestOnSocket } from '../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import {
  sendWebSocketRequest,
  sendWebSocketRequestWithStatusPreflight
} from './websocket-transport'

vi.mock('../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: vi.fn()
}))

const connection = {
  endpoint: 'ws://runtime.invalid',
  hostPublicKeyB64: 'key',
  credential: { kind: 'token', deviceToken: 'token' }
} as const
const pin = { sourceId: 'profile', runtimeId: 'runtime' }

beforeEach(() => {
  vi.mocked(sendRemoteRuntimeRequestOnSocket)
    .mockReset()
    .mockResolvedValue({
      id: 'request',
      ok: false,
      error: { code: 'method_not_found', message: 'Unknown method' },
      _meta: { runtimeId: 'runtime' }
    })
})

describe('paired CLI request pins', () => {
  it('forwards the pin after compatibility has already been checked', async () => {
    await sendWebSocketRequest(
      connection,
      'agentSession.respondToQuestion',
      {},
      1000,
      undefined,
      pin
    )
    const args = vi.mocked(sendRemoteRuntimeRequestOnSocket).mock.calls[0]
    expect(args?.[7]).toContain('agent-session.current-requests.v1')
    expect(args?.[13]).toEqual(pin)
  })

  it('keeps the pin alongside status preflight', async () => {
    const validateStatus = vi.fn()
    await sendWebSocketRequestWithStatusPreflight(
      connection,
      'agentSession.respondToApproval',
      {},
      1000,
      validateStatus,
      undefined,
      undefined,
      pin
    )
    const args = vi.mocked(sendRemoteRuntimeRequestOnSocket).mock.calls[0]
    expect(args?.[5]).toBe(validateStatus)
    expect(args?.[13]).toEqual(pin)
  })
})
