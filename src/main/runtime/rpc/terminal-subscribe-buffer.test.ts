/* oxlint-disable max-lines -- Why: terminal subscribe buffering tests share a live dispatcher harness; splitting would duplicate stream setup and weaken lifecycle coverage. */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal subscribe buffering', () => {
  it('settles mobile subscribe waits when the stream signal aborts before PTY spawn', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const controller = new AbortController()
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
        waitForLeafPtyId: vi.fn(
          (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
                once: true
              })
            })
        ),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false })
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'phone-1', type: 'mobile' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          signal: controller.signal,
          connectionId: 'conn-phone',
          sendBinary: vi.fn(),
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      expect(runtime.waitForLeafPtyId).toHaveBeenCalled()
      controller.abort()
      const outcomePromise = Promise.race([
        dispatchPromise.then(() => 'settled'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
      ])
      await vi.advanceTimersByTimeAsync(0)

      expect(await outcomePromise).toBe('settled')
      expect(runtime.readTerminal).not.toHaveBeenCalled()
      expect(messages).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks scrollback-only subscribed previews truncated when the uncursored read is limited', async () => {
    const messages: string[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      readTerminal: vi
        .fn()
        .mockResolvedValue({ tail: ['line 120'], truncated: false, limited: true })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', { terminal: 'terminal-1' }),
      (msg) => messages.push(msg)
    )

    expect(messages.map((msg) => JSON.parse(msg).result)).toEqual([
      {
        type: 'subscribed',
        streamId: null,
        lines: ['line 120'],
        truncated: true
      },
      { type: 'end' }
    ])
  })

  it('marks legacy scrollback previews truncated when the uncursored read is limited', async () => {
    const messages: string[] = []
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi
        .fn()
        .mockResolvedValue({ tail: ['line 120'], truncated: false, limited: true }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' }
      }),
      (msg) => messages.push(msg)
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'scrollback')).toBe(true)
    )
    const scrollback = messages
      .map((msg) => JSON.parse(msg).result)
      .find((result) => result?.type === 'scrollback')
    expect(scrollback).toMatchObject({
      type: 'scrollback',
      lines: ['line 120'],
      truncated: true
    })

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })

  it('marks binary subscribed previews truncated when the uncursored read is limited', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi
        .fn()
        .mockResolvedValue({ tail: ['line 120'], truncated: false, limited: true }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateMobileViewport: vi.fn().mockResolvedValue(false)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-binary-limited',
        sendBinary: (bytes) => binaryFrames.push(bytes)
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const subscribed = messages
      .map((msg) => JSON.parse(msg).result)
      .find((result) => result?.type === 'subscribed')
    expect(subscribed).toMatchObject({
      type: 'subscribed',
      lines: ['line 120'],
      truncated: true
    })
    const snapshotStart = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
      truncated: true
    })

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })

  it('does not mark binary snapshot frames truncated from a limited read when serialized data is available', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi
        .fn()
        .mockResolvedValue({ tail: ['line 120'], truncated: false, limited: true }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'serialized snapshot\r\n',
        cols: 100,
        rows: 30
      }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateMobileViewport: vi.fn().mockResolvedValue(false)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-binary-serialized-limited',
        sendBinary: (bytes) => binaryFrames.push(bytes)
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const snapshotStart = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
    expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
      cols: 100,
      rows: 30,
      truncated: false,
      truncatedByByteBudget: false
    })

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })

  it('bounds legacy binary output queued while the initial snapshot is serializing', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      let resolveSnapshot: (value: { data: string; cols: number; rows: number }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateMobileViewport: vi.fn().mockResolvedValue(false)
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered',
          sendBinary: (bytes) => binaryFrames.push(bytes)
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(`${String(index).padStart(3, '0')}${'x'.repeat(1021)}`)
      }
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
      resolveSnapshot({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output.length).toBeLessThanOrEqual(256 * 1024)
      expect(output).not.toContain('000')
      expect(output).toContain('399')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })
})
