import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const request: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    viewport: { cols: 40, rows: 20 },
    capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
  }
}

describe('terminal lease-only subscription', () => {
  it('keeps mobile input ownership without viewport resize or output delivery', async () => {
    const messages: string[] = []
    const cleanups = new Map<string, () => void>()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      handleMobileLeaseSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn(),
      registerRemoteTerminalViewSubscriber: vi.fn(),
      readTerminal: vi.fn(),
      serializeTerminalBuffer: vi.fn(),
      subscribeToTerminalResize: vi.fn(),
      subscribeToFitOverrideChanges: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      request,
      (message) => messages.push(message),
      {
        connectionId: 'conn-phone',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
        true
      )
    )
    const subscribed = messages
      .map((message) => JSON.parse(message).result)
      .find((result) => result?.type === 'subscribed')
    expect(subscribed).toMatchObject({
      leaseReady: true,
      readinessTiming: {
        serverTotalMs: expect.any(Number),
        ptyWaitMs: 0,
        leaseRegisterMs: expect.any(Number)
      }
    })
    expect(runtime.handleMobileLeaseSubscribe).toHaveBeenCalledWith('pty-1', 'phone-1')
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()
    expect(runtime.registerRemoteTerminalViewSubscriber).not.toHaveBeenCalled()
    expect(runtime.readTerminal).not.toHaveBeenCalled()
    expect(runtime.serializeTerminalBuffer).not.toHaveBeenCalled()
    expect(runtime.subscribeToTerminalResize).not.toHaveBeenCalled()
    expect(runtime.subscribeToFitOverrideChanges).not.toHaveBeenCalled()

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith('pty-1', 'phone-1')
  })

  it('reports retryable terminal unavailability without a false lease acknowledgement', async () => {
    const messages: string[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue(null),
      requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('timeout')),
      readTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(request, (message) => messages.push(message), {
      connectionId: 'conn-phone',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    const results = messages.map((message) => JSON.parse(message).result)
    expect(results).toEqual([
      expect.objectContaining({
        type: 'terminal-unavailable',
        reason: 'pty-not-ready',
        retryable: true,
        readinessTiming: expect.objectContaining({
          serverTotalMs: expect.any(Number),
          ptyWaitMs: expect.any(Number)
        })
      }),
      { type: 'end' }
    ])
    expect(runtime.readTerminal).not.toHaveBeenCalled()
    expect(results).not.toContainEqual(expect.objectContaining({ type: 'subscribed' }))
  })
})
