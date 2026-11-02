import { describe, expect, it, vi } from 'vitest'
import { negotiateMobileRuntimeCapabilities } from './mobile-runtime-capability-negotiation'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'

function negotiate(args: { reject: unknown }): {
  onReady: ReturnType<typeof vi.fn>
  onFailure: ReturnType<typeof vi.fn>
} {
  const onReady = vi.fn()
  const onFailure = vi.fn()
  negotiateMobileRuntimeCapabilities({
    sendRequest: () => Promise.reject(args.reject),
    current: () => true,
    onReady,
    onFailure
  })
  return { onReady, onFailure }
}

describe('mobile runtime capability negotiation', () => {
  it('connects a new phone when an older desktop does not implement the advisory', async () => {
    const onReady = vi.fn()
    const onFailure = vi.fn()
    negotiateMobileRuntimeCapabilities({
      sendRequest: async () => ({
        id: 'caps',
        ok: false,
        error: { code: 'unknown_method', message: 'Unknown method' }
      }),
      current: () => true,
      onReady,
      onFailure
    })
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce())
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('proceeds when the host never answers, so a slow link still reaches connected', async () => {
    const timedOut = markRpcDeliveryUnknown(
      new Error('Request timed out: runtime.clientCapabilities.update')
    )
    const { onReady, onFailure } = negotiate({ reject: timedOut })

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('proceeds when the socket drops the request mid-flight', async () => {
    const interrupted = markRpcDeliveryUnknown(new Error('Connection interrupted'))
    const { onReady, onFailure } = negotiate({ reject: interrupted })

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1))
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('fails a socket that could not put the advisory on the wire', async () => {
    const { onReady, onFailure } = negotiate({ reject: new Error('Connection interrupted') })

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1))
    expect(onReady).not.toHaveBeenCalled()
  })

  it.each(['successful', 'unanswered', 'unsent'] as const)(
    'leaves a replaced session alone after a %s request settles',
    async (outcome) => {
      const onReady = vi.fn()
      const onFailure = vi.fn()
      let resolveRequest!: (response: RpcResponse) => void
      let rejectRequest!: (error: Error) => void
      const request = new Promise<RpcResponse>((resolve, reject) => {
        resolveRequest = resolve
        rejectRequest = reject
      })
      let current = true
      let checkedCurrent!: () => void
      const settled = new Promise<void>((resolve) => {
        checkedCurrent = resolve
      })
      negotiateMobileRuntimeCapabilities({
        sendRequest: () => request,
        current: () => {
          checkedCurrent()
          return current
        },
        onReady,
        onFailure
      })

      current = false
      if (outcome === 'successful') {
        resolveRequest({ id: 'capability-1', ok: true, result: {} })
      } else {
        const error = new Error('Connection interrupted')
        rejectRequest(outcome === 'unanswered' ? markRpcDeliveryUnknown(error) : error)
      }
      await settled
      expect(onReady).not.toHaveBeenCalled()
      expect(onFailure).not.toHaveBeenCalled()
    }
  )
})
