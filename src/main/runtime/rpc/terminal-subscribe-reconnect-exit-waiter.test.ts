import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const request = (id: string): RpcRequest => ({
  id,
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    viewport: { cols: 40, rows: 20 },
    capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
  }
})

describe('terminal subscribe reconnect exit-waiter', () => {
  it('a stale exit-waiter from the pre-reconnect connection must not kill the rebound live stream', async () => {
    const cleanups = new Map<string, () => void>()
    const waitRejects: Array<(reason?: unknown) => void> = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        const existing = cleanups.get(id)
        if (existing) {
          // Why: mirrors the runtime rebind — the old stream is torn down before the new one owns the id.
          existing()
        }
        cleanups.set(id, cleanup)
      }),
      getSubscriptionCleanup: vi.fn((id: string) => cleanups.get(id)),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        if (cleanup) {
          cleanup()
          cleanups.delete(id)
        }
      }),
      waitForTerminal: vi.fn(
        () =>
          new Promise<RuntimeTerminalWait>((_, reject) => {
            waitRejects.push(reject)
          })
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const first = dispatcher.dispatchStreaming(request('req-1'), vi.fn(), {
      connectionId: 'conn-phone-a',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })
    await vi.waitFor(() => expect(waitRejects).toHaveLength(1))

    // Reconnect: the same terminal+client subscribes again on a fresh connection,
    // rebinding the composite id to the new stream and tearing down the old one.
    const second = dispatcher.dispatchStreaming(request('req-2'), vi.fn(), {
      connectionId: 'conn-phone-b',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })
    await vi.waitFor(() => expect(waitRejects).toHaveLength(2))
    const liveCleanup = cleanups.get('terminal-1:phone-1')
    expect(liveCleanup).toBeDefined()

    // The old connection dies after the rebind; its exit-waiter must not touch the live stream.
    waitRejects[0]!(new Error('connection aborted'))
    await Promise.resolve()
    await Promise.resolve()

    expect(runtime.cleanupSubscription).not.toHaveBeenCalled()
    expect(cleanups.get('terminal-1:phone-1')).toBe(liveCleanup)

    runtime.cleanupSubscription('terminal-1:phone-1')
    await first
    await second
  })

  it('a stale setup rejection after rebind must not kill the rebound live stream', async () => {
    const cleanups = new Map<string, () => void>()
    const waitRejects: Array<(reason?: unknown) => void> = []
    let rejectFirstSubscribe: ((reason?: unknown) => void) | null = null
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      handleMobileSubscribe: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<boolean>((_, reject) => {
              rejectFirstSubscribe = reject
            })
        )
        .mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        const existing = cleanups.get(id)
        if (existing) {
          existing()
        }
        cleanups.set(id, cleanup)
      }),
      getSubscriptionCleanup: vi.fn((id: string) => cleanups.get(id)),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        if (cleanup) {
          cleanup()
          cleanups.delete(id)
        }
      }),
      waitForTerminal: vi.fn(
        () =>
          new Promise<RuntimeTerminalWait>((_, reject) => {
            waitRejects.push(reject)
          })
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    // First subscribe stays pending mid-setup while the reconnect rebinds the id.
    const first = dispatcher.dispatchStreaming(request('req-1'), vi.fn(), {
      connectionId: 'conn-phone-a',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })
    await vi.waitFor(() => expect(rejectFirstSubscribe).not.toBeNull())
    expect(cleanups.get('terminal-1:phone-1')).toBeDefined()

    const second = dispatcher.dispatchStreaming(request('req-2'), vi.fn(), {
      connectionId: 'conn-phone-b',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })
    await vi.waitFor(() => expect(waitRejects).toHaveLength(2))
    const liveCleanup = cleanups.get('terminal-1:phone-1')
    expect(liveCleanup).toBeDefined()

    // The old setup fails after the rebind; its error cleanup must not touch the live stream.
    rejectFirstSubscribe!(new Error('pty gone'))
    await first

    expect(runtime.cleanupSubscription).not.toHaveBeenCalled()
    expect(cleanups.get('terminal-1:phone-1')).toBe(liveCleanup)

    runtime.cleanupSubscription('terminal-1:phone-1')
    await second
  })
})
