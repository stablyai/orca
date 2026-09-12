import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { OrcaRuntimeService, RuntimeTerminalDataMeta } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  SET_OUTPUT_PAUSED_OPCODE,
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('withholds sustained output from multiple paused desktop streams', async () => {
    const listeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
    const harness = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        listeners.push(listener)
        return vi.fn()
      }),
      serializeAuthoritativeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'authoritative hidden snapshot',
        cols: 120,
        rows: 40,
        seq: 7,
        source: 'headless'
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    for (const streamId of [1, 2, 3]) {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: `terminal-${streamId}`,
              client: { id: `desktop-${streamId}`, type: 'desktop' },
              capabilities: { ackOutput: 1, outputPause: 1 }
            })
          })
        )!
      )
    }
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(3)
    )
    const pauseCapable = harness.messages
      .map((message) => JSON.parse(message).result)
      .filter((event) => event?.type === 'subscribed')
      .every((event) => event.capabilities?.outputPause === 1)
    if (pauseCapable) {
      for (const streamId of [1, 2, 3]) {
        harness.handlers.get(streamId)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({
              opcode: SET_OUTPUT_PAUSED_OPCODE,
              streamId,
              seq: 10,
              payload: encodeTerminalStreamJson({ paused: true })
            })
          )!
        )
      }
    }
    harness.binaryFrames.splice(0)
    const chunk = 'x'.repeat(64 * 1024)
    for (let turn = 0; turn < 8; turn += 1) {
      for (const listener of listeners) {
        listener(chunk, { seq: (turn + 1) * chunk.length, rawLength: chunk.length })
      }
    }
    expect(
      harness.binaryFrames.some(
        (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Output
      )
    ).toBe(false)
    expect(pauseCapable).toBe(true)

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: SET_OUTPUT_PAUSED_OPCODE,
          streamId: 1,
          seq: 11,
          payload: encodeTerminalStreamJson({ paused: false })
        })
      )!
    )
    listeners[0]?.('VISIBLE_MARKER', { seq: 8 * chunk.length + 14, rawLength: 14 })
    listeners[0]?.('y'.repeat(64 * 1024), {
      seq: 9 * chunk.length + 14,
      rawLength: 64 * 1024
    })
    expect(
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).toContain('VISIBLE_MARKER')

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
    expect(harness.handlers.size).toBe(0)
  })

  it('keeps output flowing when an older client does not negotiate pause', async () => {
    const listeners: ((data: string, meta?: RuntimeTerminalDataMeta) => void)[] = []
    const harness = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: vi.fn((_ptyId, nextListener) => {
        listeners.push(nextListener)
        return vi.fn()
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    harness.handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 1,
            terminal: 'terminal-legacy-client',
            client: { id: 'desktop-legacy', type: 'desktop' },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(
        harness.messages
          .map((message) => JSON.parse(message).result)
          .find((event) => event?.type === 'subscribed' && event.streamId === 1)
      ).toMatchObject({ type: 'subscribed', streamId: 1 })
    )
    const subscribed = harness.messages
      .map((message) => JSON.parse(message).result)
      .find((event) => event?.type === 'subscribed' && event.streamId === 1)
    expect(subscribed.capabilities?.outputPause).toBeUndefined()

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: SET_OUTPUT_PAUSED_OPCODE,
          streamId: 1,
          seq: 2,
          payload: encodeTerminalStreamJson({ paused: true })
        })
      )!
    )
    harness.binaryFrames.splice(0)
    listeners[0]?.('LEGACY_VISIBLE'.padEnd(64 * 1024, 'x'), {
      seq: 64 * 1024,
      rawLength: 64 * 1024
    })

    expect(
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
    ).toContain('LEGACY_VISIBLE')

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('drops stale mobile resize re-stream completions for multiplex streams', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const registry = createSubscriptionRegistryDouble()
    let resizeListener:
      | ((event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq: number
        }) => void)
      | undefined
    const restreamResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
    const write = vi.fn()
    const commit = vi.fn().mockResolvedValue(undefined)
    const beginMobileInputFloor = vi.fn(() => ({ commit, rollback: vi.fn() }))
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial', cols: 80, rows: 24 })
        .mockImplementation(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              restreamResolves.push(resolve)
            })
        ),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn((_, listener) => {
        resizeListener = listener as typeof resizeListener
        return vi.fn()
      }),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockImplementation(async (_handle, _action, options) => {
        options.reserveWrite('pty-1')
        write()
        await options.afterWrite('pty-1')
        return { accepted: true }
      }),
      beginMobileInputFloor,
      updateMobileViewport: vi.fn().mockResolvedValue({ updated: false, applied: false })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-stale-multiplex-resize',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 5,
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' }
          })
        })
      )!
    )

    await vi.waitFor(() => expect(resizeListener).toBeDefined())
    handlers.get(5)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Resize,
          streamId: 5,
          seq: 2,
          payload: encodeTerminalStreamJson({ cols: 90, rows: 24 })
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.updateMobileViewport).toHaveBeenCalled())
    handlers.get(5)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 5,
          seq: 3,
          payload: encodeTerminalStreamText('x')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith(
        'terminal-1',
        { text: 'x', enter: false, interrupt: false },
        { reserveWrite: expect.any(Function), afterWrite: expect.any(Function) }
      )
    )
    expect(beginMobileInputFloor.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]!
    )
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]!)
    binaryFrames.splice(0)

    resizeListener?.({
      cols: 90,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 2
    })
    resizeListener?.({
      cols: 100,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 3
    })
    await vi.waitFor(() => expect(restreamResolves).toHaveLength(2))

    restreamResolves[1]?.({ data: 'newer', cols: 100, rows: 24 })
    await vi.waitFor(() =>
      expect(
        binaryFrames.some((frame) => {
          const decoded = decodeTerminalStreamFrame(frame)
          return (
            decoded?.opcode === TerminalStreamOpcode.SnapshotChunk &&
            decodeTerminalStreamText(decoded.payload) === 'newer'
          )
        })
      ).toBe(true)
    )
    restreamResolves[0]?.({ data: 'older', cols: 90, rows: 24 })
    await Promise.resolve()
    await Promise.resolve()

    const snapshotData = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    expect(snapshotData).toEqual(['newer'])

    registry.cleanupSubscription('terminal-multiplex:conn-stale-multiplex-resize')
    await dispatchPromise
  })

  it('owns and releases a viewport floor for legacy JSON desktop streams', async () => {
    const messages: string[] = []
    const registry = createSubscriptionRegistryDouble()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-json-1', type: 'desktop' },
        viewport: { cols: 88, rows: 30 }
      }),
      (msg) => messages.push(msg),
      { connectionId: 'conn-json-1' }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'scrollback')).toBe(true)
    )
    const subscriptionKey = vi.mocked(runtime.updateRemoteDesktopViewer).mock.calls[0]?.[1]
    expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
      'pty-1',
      expect.stringMatching(/^json:/),
      'desktop-json-1',
      88,
      30,
      true
    )

    runtime.cleanupSubscription('terminal-1:desktop-json-1')
    await dispatchPromise
    expect(runtime.unregisterRemoteDesktopViewer).toHaveBeenCalledWith('pty-1', subscriptionKey)
  })

  it('emits initial desktop fit events after the first multiplex snapshot', async () => {
    const trace: string[] = []
    let fitListener: ((event: { mode: string; cols: number; rows: number }) => void) | undefined
    let driverListener: ((driver: unknown) => void) | undefined
    const harness = startDesktopMultiplexSubscribe(
      {
        readTerminal: vi.fn(async () => {
          fitListener?.({ mode: 'desktop-fit', cols: 100, rows: 30 })
          driverListener?.({ kind: 'transition-during-snapshot' })
          return { tail: [], truncated: false } as unknown as Awaited<
            ReturnType<OrcaRuntimeService['readTerminal']>
          >
        }),
        subscribeToFitOverrideChanges: vi.fn((_ptyId, listener) => {
          fitListener = listener
          return vi.fn()
        }),
        subscribeToDriverChanges: vi.fn((_ptyId, listener) => {
          driverListener = listener
          return vi.fn()
        })
      },
      trace
    )
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(trace).toContain('driver-changed'))
    expect(trace.lastIndexOf('snapshot')).toBeLessThan(trace.indexOf('fit-override-changed'))
    expect(trace.lastIndexOf('snapshot')).toBeLessThan(trace.indexOf('driver-changed'))
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
