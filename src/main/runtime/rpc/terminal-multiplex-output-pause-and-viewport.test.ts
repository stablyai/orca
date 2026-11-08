import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'

import type { RuntimeTerminalDataMeta } from '../terminal/output/runtime-terminal-stream-consumers'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import {
  SET_OUTPUT_PAUSED_OPCODE,
  makeRequest,
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
        {
          inputKind: 'driving',
          inputSource: 'mobile',
          reserveWrite: expect.any(Function),
          afterWrite: expect.any(Function)
        }
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
})
