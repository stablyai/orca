import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const request: RpcRequest = {
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-1',
    client: { id: 'phone-1', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

describe('terminal subscribe mount replay', () => {
  it('replays a late recovery when readiness lands after the bounded initial response', async () => {
    vi.useFakeTimers()
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const registry = createSubscriptionRegistryDouble()
    let mounted = false
    let signalWaitStarted!: () => void
    const waitStarted = new Promise<void>((resolve) => {
      signalWaitStarted = resolve
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      subscribeToPtyExit: vi.fn(() => vi.fn()),
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-delayed' }),
      hasHeadlessTerminalState: vi.fn(() => false),
      requestRendererTerminalTabMount: vi.fn(() => true),
      getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
      getRendererTerminalSerializerGeneration: vi.fn(() => 1),
      getPtyOutputSequence: vi.fn(() => (mounted ? 4 : 0)),
      replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
      waitForRendererTerminalSerializer: vi.fn(
        (_ptyId: string, _afterGeneration: number, timeoutMs: number | undefined) => {
          expect(timeoutMs).toBeUndefined()
          signalWaitStarted()
          return new Promise<boolean>((resolve) => {
            setTimeout(() => {
              mounted = true
              resolve(true)
            }, 3_001)
          })
        }
      ),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(async () => ({
        data: mounted ? 'delayed idle prompt $ ' : 'late suffix-only redraw',
        cols: 80,
        rows: 24,
        seq: mounted ? 4 : 1
      })),
      serializeRendererTerminalBuffer: vi.fn(async () =>
        mounted ? { data: 'delayed idle prompt $ ', cols: 80, rows: 24, seq: 4 } : null
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
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    await waitStarted
    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.resolve()
    expect(binaryFrames.length).toBeGreaterThan(0)
    expect(
      binaryFrames
        .map((bytes) => decodeTerminalStreamFrame(bytes))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).toContain('late suffix-only redraw')
    expect(
      binaryFrames
        .map((bytes) => decodeTerminalStreamFrame(bytes))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).not.toContain('delayed idle prompt $ ')
    await vi.advanceTimersByTimeAsync(1)
    await Promise.resolve()
    await Promise.resolve()

    expect(
      binaryFrames
        .map((bytes) => decodeTerminalStreamFrame(bytes))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).toContain('delayed idle prompt $ ')

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
    vi.useRealTimers()
  })
})
