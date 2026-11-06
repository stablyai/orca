import { describe, expect, it, vi } from 'vitest'
import { requestSharedControl } from '../../../shared/remote-runtime/requests/remote-runtime-shared-control-requests'
import type { SharedControlPendingRequest } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
describe('runtime-pinned support-routed sends', () => {
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
