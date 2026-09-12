import { describe, expect, it } from 'vitest'
import { RelayPendingRequests } from './relay-pending-requests'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

// RpcClient.close() must settle every pending request: since migrateTo stopped rejecting
// pendings itself, close() is the retiring generation's only settlement path, and a request
// left pending strands its caller forever. These pin the two trackers the two real
// implementations reject through — direct-rpc-client.ts:218 and mobile-relay-rpc-session.ts:138.
describe('close settles pending requests', () => {
  it('direct: rejectAll settles every pending and marks delivery unknown', async () => {
    let nextId = 0
    const tracker = new RpcClientRequestTracker({
      nextId: () => `req-${nextId++}`,
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendEncrypted: () => true,
      deviceToken: 'token'
    })
    // Go through the real send path so these are pendings the tracker actually owns.
    const pending = [0, 1, 2].map((index) =>
      tracker.sendAuthenticatedRequest(`method.${index}`, {})
    )
    expect(tracker.size()).toBe(3)

    tracker.rejectAll('Client closed', { deliveryUnknown: true })

    const settled = await Promise.allSettled(pending)
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected', 'rejected'])
    for (const entry of settled) {
      expect(entry.status === 'rejected' && isRpcDeliveryUnknown(entry.reason)).toBe(true)
    }
    expect(tracker.size()).toBe(0)
  })

  it('relay: rejectAll settles every pending and marks delivery unknown', async () => {
    const pendingRequests = new RelayPendingRequests()
    const pending = [0, 1, 2].map((index) => {
      const id = `req-${index}`
      return new Promise<unknown>((resolve, reject) => {
        pendingRequests.track(id, {
          resolve,
          reject,
          timer: setTimeout(() => {}, 60_000)
        } as unknown as Parameters<RelayPendingRequests['track']>[1])
      })
    })

    pendingRequests.rejectAll(new Error('Client closed'))

    const settled = await Promise.allSettled(pending)
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected', 'rejected'])
    for (const entry of settled) {
      expect(entry.status === 'rejected' && isRpcDeliveryUnknown(entry.reason)).toBe(true)
    }
  })
})
