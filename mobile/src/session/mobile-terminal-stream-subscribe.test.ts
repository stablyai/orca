import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { subscribeMobileTerminalSafely } from './mobile-terminal-stream-subscribe'

describe('subscribeMobileTerminalSafely', () => {
  it('forwards successful subscriptions and safely reports a synchronous failure', () => {
    const cleanup = vi.fn()
    const onData = vi.fn()
    const successfulClient = { subscribe: vi.fn(() => cleanup) } satisfies Pick<
      RpcClient,
      'subscribe'
    >
    const params = { terminal: 'terminal-1' }
    const onSuccessError = vi.fn()

    const release = subscribeMobileTerminalSafely(successfulClient, params, onData, onSuccessError)
    expect(successfulClient.subscribe).toHaveBeenCalledExactlyOnceWith(
      'terminal.subscribe',
      params,
      onData
    )
    expect(release).toBe(cleanup)
    release()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(onSuccessError).not.toHaveBeenCalled()

    const onSynchronousError = vi.fn()
    const client = {
      subscribe: vi.fn(() => {
        throw new Error('socket closed')
      })
    } satisfies Pick<RpcClient, 'subscribe'>

    const unsubscribe = subscribeMobileTerminalSafely(
      client,
      { terminal: 'terminal-1' },
      vi.fn(),
      onSynchronousError
    )

    expect(onSynchronousError).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toThrow()
  })
})
