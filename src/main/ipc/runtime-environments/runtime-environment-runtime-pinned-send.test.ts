import { describe, expect, it, vi } from 'vitest'
import { requestSharedControl } from '../../../shared/remote-runtime/requests/remote-runtime-shared-control-requests'
import type { SharedControlPendingRequest } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { getPreferredPairedRuntimeConnection } from '../../../shared/runtime-environments'
import type * as RemoteRuntimeClient from '../../../shared/remote-runtime/remote-runtime-client'

const oneShot = vi.hoisted(() => ({ statusRuntimeId: 'runtime-a', sent: new Array<string>() }))
vi.mock('../../../shared/remote-runtime/remote-runtime-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimeClient>()),
  // The real sender asks `status.get` on the fresh socket and sends only if the check passes.
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    _connection: unknown,
    method: string,
    _params: unknown,
    _timeoutMs: number,
    validateStatus: (response: { ok: true; result: { runtimeId: string } }) => void
  ) => {
    validateStatus({ ok: true, result: { runtimeId: oneShot.statusRuntimeId } })
    oneShot.sent.push(method)
    return { id: 'rpc', ok: true, result: { ok: true }, _meta: { runtimeId: 'runtime-a' } }
  }
}))

import { sendSupportRoutedCallOnRuntime } from './runtime-environment-runtime-pinned-send'

const environment: KnownRuntimeEnvironment = {
  id: 'env',
  name: 'Environment',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: 'runtime-a',
  endpoints: [
    {
      id: 'ws',
      kind: 'websocket',
      label: 'WebSocket',
      endpoint: 'ws://host',
      deviceToken: 'token',
      publicKeyB64: 'key'
    }
  ],
  preferredEndpointId: 'ws'
}
const route = { environment, connection: getPreferredPairedRuntimeConnection(environment) }

describe('runtime-pinned support-routed sends', () => {
  it.each([
    ['the probed runtime', 'runtime-a', true],
    ['a replacement runtime', 'runtime-b', false]
  ])(
    'sends over a fresh one-shot socket only when it reached %s',
    async (_label, reached, sent) => {
      oneShot.statusRuntimeId = reached
      oneShot.sent = []

      const response = await sendSupportRoutedCallOnRuntime(
        route,
        { method: 'files.write', params: {}, timeoutMs: 100 },
        'runtime-a',
        'one-shot'
      )

      expect(response.ok).toBe(sent)
      expect(oneShot.sent).toEqual(sent ? ['files.write'] : [])
      if (!response.ok) {
        expect(response.error.code).toBe('runtime_environment_changed')
      }
    }
  )

  it('rejects a shared-socket request without sending when the pre-send check fails', async () => {
    const send = vi.fn()
    const pendingRequests = new Map<string, SharedControlPendingRequest<unknown>>()

    await expect(
      requestSharedControl({
        pendingRequests,
        deviceToken: 'device-token',
        method: 'files.write',
        params: undefined,
        timeoutMs: 1000,
        ensureReady: () => Promise.resolve(),
        send,
        beforeSend: () => {
          throw new Error('Runtime connection changed before sending')
        }
      })
    ).rejects.toThrow('changed before sending')
    expect(send).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(0)
  })
})
