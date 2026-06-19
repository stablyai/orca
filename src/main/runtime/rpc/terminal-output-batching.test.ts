import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
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

describe('terminal output batching', () => {
  it('coalesces desktop terminal output bursts before emitting stream data', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
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

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const emitData = dataListenerRef.current
      if (!emitData) {
        throw new Error('missing terminal data listener')
      }
      emitData('a')
      emitData('b')

      expect(messages.map((msg) => JSON.parse(msg).result?.type)).not.toContain('data')

      await vi.runOnlyPendingTimersAsync()

      const dataMessages = messages
        .map((msg) => JSON.parse(msg))
        .filter((message) => message.result?.type === 'data')
      expect(dataMessages).toHaveLength(1)
      expect(dataMessages[0]).toMatchObject({ result: { type: 'data', chunk: 'ab' } })

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('streams desktop terminal output as coalesced binary frames when requested', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 80,
          rows: 24
        }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
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
          connectionId: 'conn-1',
          sendBinary: (bytes) => binaryFrames.push(bytes)
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      const subscribed = messages
        .map((msg) => JSON.parse(msg))
        .find((msg) => msg.result?.type === 'subscribed')
      expect(subscribed?.result).toMatchObject({ type: 'subscribed', streamId: expect.any(Number) })
      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())

      const emitData = dataListenerRef.current
      if (!emitData) {
        throw new Error('missing terminal data listener')
      }
      emitData('a')
      emitData('b')

      expect(messages.map((msg) => JSON.parse(msg).result?.type)).not.toContain('data')

      await vi.runOnlyPendingTimersAsync()

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames).toHaveLength(1)
      expect(outputFrames[0] ? decodeTerminalStreamText(outputFrames[0].payload) : '').toBe('ab')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes binary terminal input frames back to the subscribed PTY', async () => {
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
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
    const messages: string[] = []

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-1',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() => {
      expect(messages.some((msg) => JSON.parse(msg).result?.streamId)).toBe(true)
    })
    const streamId = JSON.parse(messages.find((msg) => JSON.parse(msg).result?.streamId)!).result
      .streamId as number
    handlers.get(streamId)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId,
          seq: 1,
          payload: encodeTerminalStreamText('ls\r')
        })
      )!
    )

    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'ls\r',
        enter: false,
        interrupt: false
      })
    )

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })
})
