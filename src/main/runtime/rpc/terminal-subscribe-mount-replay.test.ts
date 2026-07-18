import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
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
    capabilities: { terminalBinaryStream: 1 }
  }
}

describe('terminal subscribe mount replay', () => {
  it('includes the restored idle screen when a missing model is background-mounted', async () => {
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let mounted = false
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      hasHeadlessTerminalState: vi.fn(() => mounted),
      requestRendererTerminalTabMount: vi.fn(() => true),
      getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 3),
      getRendererTerminalSerializerGeneration: vi.fn(() => 3),
      getPtyOutputSequence: vi.fn(() => (mounted ? 4 : 0)),
      replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
      waitForRendererTerminalSerializer: vi.fn(async (_ptyId, afterGeneration) => {
        expect(afterGeneration).toBe(3)
        mounted = true
        return true
      }),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(async () =>
        mounted
          ? { data: 'idle prompt $ ', cols: 80, rows: 24, seq: 4 }
          : { data: '', cols: 80, rows: 24, seq: 1 }
      ),
      serializeRendererTerminalBuffer: vi.fn(async () =>
        mounted ? { data: 'idle prompt $ ', cols: 80, rows: 24, seq: 4 } : null
      ),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
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

    const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    await vi.waitFor(() => expect(runtime.requestRendererTerminalTabMount).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((bytes) => decodeTerminalStreamFrame(bytes))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => decodeTerminalStreamText(frame!.payload))
          .join('')
      ).toContain('idle prompt $ ')
    )

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })

  it('prefers restored history when phone-fit creates suffix-only headless state', async () => {
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let generation = 1
    let headlessPresent = false
    let serializeCalls = 0
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      hasHeadlessTerminalState: vi.fn(() => headlessPresent),
      requestRendererTerminalTabMount: vi.fn(() => true),
      getRendererTerminalSerializerGenerationForHandle: vi.fn(() => generation),
      getRendererTerminalSerializerGeneration: vi.fn(() => generation),
      getPtyOutputSequence: vi.fn(() => 0),
      replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
      waitForRendererTerminalSerializer: vi.fn(async (_ptyId, afterGeneration) => {
        return generation > afterGeneration
      }),
      handleMobileSubscribe: vi.fn(async () => {
        headlessPresent = true
        generation = 2
        return true
      }),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(async () => {
        serializeCalls += 1
        if (serializeCalls === 1) {
          return { data: 'suffix-only redraw', cols: 80, rows: 24, seq: 2 }
        }
        return { data: 'raced idle prompt $ ', cols: 80, rows: 24, seq: 5 }
      }),
      serializeRendererTerminalBuffer: vi.fn(async () => ({
        data: 'raced idle prompt $ ',
        cols: 80,
        rows: 24,
        seq: 5
      })),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
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

    const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((bytes) => decodeTerminalStreamFrame(bytes))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => decodeTerminalStreamText(frame!.payload))
          .join('')
      ).toContain('raced idle prompt $ ')
    )
    expect(
      binaryFrames
        .map((bytes) => decodeTerminalStreamFrame(bytes))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).not.toContain('suffix-only redraw')
    expect(runtime.waitForRendererTerminalSerializer).toHaveBeenCalledWith(
      'pty-1',
      1,
      undefined,
      expect.any(AbortSignal)
    )

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })

  it('replays a late recovery when readiness lands after the bounded initial response', async () => {
    vi.useFakeTimers()
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let mounted = false
    let signalWaitStarted!: () => void
    const waitStarted = new Promise<void>((resolve) => {
      signalWaitStarted = resolve
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
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

  it('recovers from the pre-mount generation when suffix state appears during the PTY wait', async () => {
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let generation = 0
    let headlessPresent = false
    const requestRendererTerminalTabMount = vi.fn(() => {
      generation = 1
      return true
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue(null),
      waitForLeafPtyId: vi.fn(async () => {
        // A redraw may reach main before the PTY wait completes, but it does
        // not contain the legacy terminal's restored history.
        headlessPresent = true
        return 'pty-late-leaf'
      }),
      hasHeadlessTerminalState: vi.fn(() => headlessPresent),
      requestRendererTerminalTabMount,
      getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 0),
      getRendererTerminalSerializerGeneration: vi.fn(() => generation),
      getPtyOutputSequence: vi.fn(() => 0),
      replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
      waitForRendererTerminalSerializer: vi.fn(async (_ptyId, afterGeneration) => {
        return generation > afterGeneration
      }),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'suffix-only redraw',
        cols: 80,
        rows: 24,
        seq: 1
      }),
      serializeRendererTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'late leaf prompt $ ',
        cols: 80,
        rows: 24
      }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
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

    const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((bytes) => decodeTerminalStreamFrame(bytes))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => decodeTerminalStreamText(frame!.payload))
          .join('')
      ).toContain('late leaf prompt $ ')
    )
    expect(requestRendererTerminalTabMount).toHaveBeenCalledTimes(1)
    expect(runtime.waitForRendererTerminalSerializer).toHaveBeenCalledWith(
      'pty-late-leaf',
      0,
      undefined,
      expect.any(AbortSignal)
    )

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })

  it('cancels the mount-ready wait when the mobile subscription closes', async () => {
    const cleanups = new Map<string, () => void>()
    let waitSignal: AbortSignal | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      hasHeadlessTerminalState: vi.fn(() => false),
      requestRendererTerminalTabMount: vi.fn(() => true),
      getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
      getRendererTerminalSerializerGeneration: vi.fn(() => 1),
      getPtyOutputSequence: vi.fn(() => 0),
      replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(),
      waitForRendererTerminalSerializer: vi.fn(
        (_ptyId: string, _afterGeneration: number, _timeoutMs: number, signal?: AbortSignal) => {
          waitSignal = signal
          return new Promise<boolean>((resolve) => {
            signal?.addEventListener('abort', () => resolve(false), { once: true })
          })
        }
      ),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      serializeRendererTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
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

    const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
      connectionId: 'conn-phone',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    await vi.waitFor(() => expect(runtime.waitForRendererTerminalSerializer).toHaveBeenCalled())
    runtime.cleanupSubscription('terminal-1:phone-1')

    expect(waitSignal?.aborted).toBe(true)
    await dispatchPromise
  })
})
