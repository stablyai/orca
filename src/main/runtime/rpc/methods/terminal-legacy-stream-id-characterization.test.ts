import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-types'
import { createSubscriptionRegistryDouble } from '../subscription-registry-test-double'
import { TERMINAL_METHODS } from './terminal'

function request(params: unknown): RpcRequest {
  return {
    id: 'request',
    authToken: 'token',
    method: 'terminal.subscribe',
    params
  }
}

describe('legacy terminal subscription stream IDs', () => {
  it('allocates binary and JSON subscriptions from one monotonically increasing owner', async () => {
    const registry = createSubscriptionRegistryDouble()
    const runtime = {
      getRuntimeId: () => 'runtime',
      resolveLeafForHandle: vi.fn(() => ({ ptyId: 'pty' })),
      readTerminal: vi.fn(async () => ({ tail: [], truncated: false })),
      serializeTerminalBuffer: vi.fn(async () => ({ data: '', cols: 80, rows: 24 })),
      getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
      getMobileDisplayMode: vi.fn(() => 'auto'),
      getLayout: vi.fn(() => ({ seq: 1 })),
      subscribeToTerminalData: vi.fn(() => () => {}),
      registerRemoteTerminalViewSubscriber: vi.fn(() => () => {}),
      subscribeToTerminalResize: vi.fn(() => () => {}),
      subscribeToFitOverrideChanges: vi.fn(() => () => {}),
      subscribeToPtyExit: vi.fn(() => () => {}),
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    } as unknown as Partial<OrcaRuntimeService>
    const dispatcher = new RpcDispatcher({
      runtime: runtime as OrcaRuntimeService,
      methods: TERMINAL_METHODS
    })

    const subscribeBinary = async (terminal: string, clientId: string) => {
      const messages: string[] = []
      const pending = dispatcher.dispatchStreaming(
        request({
          terminal,
          client: { id: clientId, type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (message) => messages.push(message),
        { connectionId: `connection-${clientId}`, sendBinary: () => {} }
      )
      await vi.waitFor(() =>
        expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
          true
        )
      )
      const subscribed = messages
        .map((message) => JSON.parse(message))
        .find((message) => message.result?.type === 'subscribed')
      const streamId = subscribed?.result?.streamId
      if (typeof streamId !== 'number') {
        throw new Error('Missing legacy binary stream ID')
      }
      runtime.cleanupSubscription?.(`${terminal}:${clientId}`)
      await pending
      return streamId
    }

    const first = await subscribeBinary('terminal-a', 'client-a')

    const jsonMessages: string[] = []
    const jsonPending = dispatcher.dispatchStreaming(
      request({ terminal: 'terminal-json', client: { id: 'client-json', type: 'desktop' } }),
      (message) => jsonMessages.push(message),
      { connectionId: 'connection-json' }
    )
    await vi.waitFor(() =>
      expect(
        jsonMessages.some((message) => JSON.parse(message).result?.type === 'scrollback')
      ).toBe(true)
    )
    runtime.cleanupSubscription?.('terminal-json:client-json')
    await jsonPending

    const second = await subscribeBinary('terminal-b', 'client-b')
    expect(second).toBe(first + 2)
  })
})
