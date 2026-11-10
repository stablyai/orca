import { describe, expect, it, vi } from 'vitest'

import type { OrcaRuntimeService } from '../orca-runtime'

import { RuntimeSubscriptionRegistry } from '../client/runtime-subscription-registry'

import type { RpcRequest } from './core'

import { RpcDispatcher } from './dispatcher'

import { TERMINAL_METHODS } from './methods/terminal/terminal'

import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const SUBSCRIPTION_ID = 'terminal-1:phone-1'

type Waiter = { resolve: () => void }

function stubRuntime(
  registry: ReturnType<typeof createSubscriptionRegistryDouble>,
  waiters: Waiter[],
  overrides: Record<string, unknown> = {}
): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime supplies the terminal RPC methods these tests invoke.
  return {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 80, rows: 24, seq: 4 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    cleanupSubscriptionIfOwnedByConnection: vi.fn(registry.cleanupSubscriptionIfOwnedByConnection),
    getSubscriptionRegistrationVersion: registry.getSubscriptionRegistrationVersion,
    subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
      waiters.push({ resolve: listener })
      return vi.fn()
    }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

const makeRequest = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params
})

const binaryParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1 }
}

const leaseOnlyParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
}

const streamOptions = (connectionId: string, signal?: AbortSignal) => ({
  signal,
  connectionId,
  sendBinary: vi.fn(),
  registerBinaryStreamHandler: vi.fn(() => vi.fn())
})

describe('terminal.unsubscribe connection ownership', () => {
  const unsubscribeRequest = (subscriptionId: string): RpcRequest => ({
    id: 'req-unsub',
    authToken: 'tok',
    method: 'terminal.unsubscribe',
    params: { subscriptionId, client: { id: 'phone-1' } }
  })

  it.each(
    [binaryParams, leaseOnlyParams].flatMap((params) =>
      ['streaming', 'unary'].flatMap((transport) =>
        [SUBSCRIPTION_ID, 'terminal-1'].map((subscriptionId) => ({
          params,
          transport,
          subscriptionId
        }))
      )
    )
  )(
    'keeps the replacement when $transport unsubscribe of $subscriptionId yields',
    async ({ params, transport, subscriptionId }) => {
      const registry = new RuntimeSubscriptionRegistry()
      const runtime = stubRuntime(createSubscriptionRegistryDouble(), [], {
        registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry),
        cleanupSubscriptionIfOwnedByConnection: registry.cleanupIfOwnedByConnection.bind(registry),
        getSubscriptionRegistrationVersion: registry.getRegistrationVersion.bind(registry)
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const connection = streamOptions('conn-a')
      const original = dispatcher.dispatchStreaming(makeRequest(params), vi.fn(), connection)
      await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalledTimes(1))

      const replies: string[] = []
      const retiring =
        transport === 'streaming'
          ? dispatcher.dispatchStreaming(
              unsubscribeRequest(subscriptionId),
              (reply) => replies.push(reply),
              { connectionId: 'conn-a' }
            )
          : dispatcher
              .dispatch(unsubscribeRequest(subscriptionId), { connectionId: 'conn-a' })
              .then((reply) => replies.push(JSON.stringify(reply)))
      const replacementMessages: string[] = []
      const replacement = dispatcher.dispatchStreaming(
        { ...makeRequest(params), id: 'req-replacement' },
        (reply) => replacementMessages.push(reply),
        connection
      )
      await retiring

      try {
        expect(runtime.handleMobileSubscribe).toHaveBeenCalledTimes(2)
        expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledTimes(1)
        expect(replacementMessages.some((reply) => JSON.parse(reply).result?.type === 'end')).toBe(
          false
        )
        expect(JSON.parse(replies[0]!).result).toEqual({ unsubscribed: false })
      } finally {
        registry.cleanupForConnection('conn-a')
        await Promise.all([original, replacement])
      }
    }
  )
})
