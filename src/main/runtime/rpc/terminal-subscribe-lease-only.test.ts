import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

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
    const registry = createSubscriptionRegistryDouble()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn(),
      registerRemoteTerminalViewSubscriber: vi.fn(),
      readTerminal: vi.fn(),
      serializeTerminalBuffer: vi.fn(),
      subscribeToTerminalResize: vi.fn(),
      subscribeToFitOverrideChanges: vi.fn(),
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
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
    expect(runtime.handleMobileSubscribe).toHaveBeenCalledWith('pty-1', 'phone-1', undefined)
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
})
