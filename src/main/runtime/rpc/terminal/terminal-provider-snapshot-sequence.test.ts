import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from '../testing/subscription-registry-test-double'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../../shared/terminal/stream/terminal-stream-protocol'

const request: RpcRequest = {
  id: 'req-provider-sequence',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-restored',
    client: { id: 'phone-1', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

it('replays post-capture output in the provider snapshot sequence domain', async () => {
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const registry = createSubscriptionRegistryDouble()
  let dataListener:
    | ((data: string, meta?: { seq?: number; rawLength?: number }) => void)
    | undefined
  let resolveSnapshot:
    | ((snapshot: { data: string; cols: number; rows: number; seq: number }) => void)
    | undefined
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: () => () => {},
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-restored' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      dataListener = listener
      return vi.fn()
    }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn(
      () =>
        new Promise<{ data: string; cols: number; rows: number; seq: number }>((resolve) => {
          resolveSnapshot = resolve
        })
    ),
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
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
    connectionId: 'conn-restored',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    }
  })

  await vi.waitFor(() => expect(resolveSnapshot).toBeDefined())
  resolveSnapshot?.({ data: 'restored snapshot', cols: 80, rows: 24, seq: 900 })
  // Attach anchoring continues at 905, not 5, so snapshot reconciliation retains the new chunk.
  dataListener?.('fresh', { seq: 905, rawLength: 5 })

  await vi.waitFor(() =>
    expect(
      binaryFrames.some((bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return (
          frame?.opcode === TerminalStreamOpcode.Output &&
          decodeTerminalStreamText(frame.payload) === 'fresh'
        )
      })
    ).toBe(true)
  )

  runtime.cleanupSubscription('terminal-restored:phone-1')
  await dispatchPromise
})
