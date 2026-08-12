import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { subscribeMobileTerminalSafely } from './mobile-terminal-stream-subscribe'

describe('subscribeMobileTerminalSafely', () => {
  it('reports a synchronous subscribe failure and returns a safe no-op cleanup', () => {
    const onSynchronousError = vi.fn()
    const client = {
      subscribe: vi.fn(() => {
        throw new Error('socket closed')
      })
    } as unknown as Pick<RpcClient, 'subscribe'>

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
