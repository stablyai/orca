import { expect, it, vi } from 'vitest'
import { RpcClientRequestTracker } from './rpc-client-request-tracker'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

it('rechecks authority after connecting without retaining or sending a cancelled request', async () => {
  const connected = Promise.withResolvers<void>()
  const sendEncrypted = vi.fn(() => true)
  const tracker = new RpcClientRequestTracker({
    nextId: () => 'request',
    getState: () => 'connected',
    waitForConnected: () => connected.promise,
    sendEncrypted,
    deviceToken: 'test-token'
  })
  let active = true
  const failure = new Error('Retired document')
  const request = tracker.sendRequest(
    'future.write',
    {},
    {
      beforeSend: () => {
        if (!active) {
          throw failure
        }
      }
    }
  )
  active = false
  connected.resolve()
  await expect(request).rejects.toBe(failure)
  expect(isRpcDeliveryUnknown(failure)).toBe(false)
  expect(sendEncrypted).not.toHaveBeenCalled()
  expect(tracker.size()).toBe(0)
})
