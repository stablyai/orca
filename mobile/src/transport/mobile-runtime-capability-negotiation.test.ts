import { describe, expect, it, vi } from 'vitest'
import { negotiateMobileRuntimeCapabilities } from './mobile-runtime-capability-negotiation'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'

function negotiate(args: { reject: unknown; current?: boolean }): {
  onReady: ReturnType<typeof vi.fn>
  onFailure: ReturnType<typeof vi.fn>
} {
  const onReady = vi.fn()
  const onFailure = vi.fn()
  negotiateMobileRuntimeCapabilities({
    sendRequest: () => Promise.reject(args.reject),
    current: () => args.current ?? true,
    onReady,
    onFailure
  })
  return { onReady, onFailure }
}

describe('mobile runtime capability negotiation', () => {
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

  it('leaves a replaced session alone on an unanswered request', async () => {
    const timedOut = markRpcDeliveryUnknown(new Error('Request timed out'))
    const { onReady, onFailure } = negotiate({ reject: timedOut, current: false })

    await vi.waitFor(() => expect(onReady).not.toHaveBeenCalled())
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('leaves a replaced session alone on a successful response', async () => {
    const onReady = vi.fn()
    const onFailure = vi.fn()
    negotiateMobileRuntimeCapabilities({
      sendRequest: () =>
        Promise.resolve({ id: 'capability-1', ok: true, result: {} } as RpcResponse),
      current: () => false,
      onReady,
      onFailure
    })

    await vi.waitFor(() => expect(onReady).not.toHaveBeenCalled())
    expect(onFailure).not.toHaveBeenCalled()
  })
})
