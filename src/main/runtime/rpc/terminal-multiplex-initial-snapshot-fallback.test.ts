import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

type SerializedBuffer = {
  data: string
  scrollbackAnsi?: string
  cols: number
  rows: number
  seq?: number
  source?: 'headless' | 'renderer'
  cwd?: string
  pendingEscapeTailAnsi?: string
} | null

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function subscribeSnapshot(options: {
  connectionId: string
  serialized: SerializedBuffer
  tail: string[]
}): Promise<{ start: Record<string, unknown>; data: string }> {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const cleanups = new Map<string, () => void>()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    readTerminal: vi.fn().mockResolvedValue({ tail: options.tail, truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue(options.serialized),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => cleanups.get(id)?.()),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (message) => messages.push(message),
    {
      connectionId: options.connectionId,
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
    expect(messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(true)
  )
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 7,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' }
        })
      })
    )!
  )
  await vi.waitFor(() =>
    expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(true)
  )

  const frames = binaryFrames
    .map((bytes) => decodeTerminalStreamFrame(bytes))
    .filter((frame) => frame?.streamId === 7)
  const start = frames.find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)!
  const data = frames
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
    .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    .join('')
  cleanups.get(`terminal-multiplex:${options.connectionId}`)?.()
  await dispatchPromise
  return { start: decodeTerminalStreamJson<Record<string, unknown>>(start.payload)!, data }
}

describe('terminal multiplex initial snapshot fallback', () => {
  it('serves the retained tail when serialization returns an empty snapshot object', async () => {
    const snapshot = await subscribeSnapshot({
      connectionId: 'conn-empty-snapshot-tail',
      serialized: {
        data: '',
        cols: 120,
        rows: 40,
        seq: 42,
        source: 'renderer',
        cwd: '/stale'
      },
      tail: ['retained line 1', 'retained line 2']
    })

    expect(snapshot.data).toBe('retained line 1\r\nretained line 2\r\n')
    expect(snapshot.start.unavailable).toBeUndefined()
    expect(snapshot.start.seq).toBeUndefined()
    expect(snapshot.start.source).toBeUndefined()
    expect(snapshot.start.cwd).toBeUndefined()
  })

  it('keeps the retained-tail fallback when serialization returns null', async () => {
    const snapshot = await subscribeSnapshot({
      connectionId: 'conn-null-snapshot-tail',
      serialized: null,
      tail: ['retained line']
    })

    expect(snapshot.data).toBe('retained line\r\n')
    expect(snapshot.start.unavailable).toBeUndefined()
  })

  it('does not rebuild the retained tail when serialized content is available', async () => {
    const tail = ['retained line']
    const tailJoin = vi.spyOn(tail, 'join')
    const snapshot = await subscribeSnapshot({
      connectionId: 'conn-serialized-snapshot-tail',
      serialized: { data: 'serialized screen', cols: 120, rows: 40 },
      tail
    })

    expect(snapshot.data).toBe('serialized screen')
    expect(tailJoin).not.toHaveBeenCalled()
  })

  it('reports unavailable when neither serialized data nor a retained tail exists', async () => {
    const snapshot = await subscribeSnapshot({
      connectionId: 'conn-null-snapshot-no-tail',
      serialized: null,
      tail: []
    })

    expect(snapshot.data).toBe('')
    expect(snapshot.start.unavailable).toBe('no-serializable-buffer')
  })

  it('reports a successful empty snapshot when the serializer answered and no tail exists', async () => {
    const snapshot = await subscribeSnapshot({
      connectionId: 'conn-empty-snapshot-no-tail',
      serialized: { data: '', cols: 120, rows: 40, seq: 42, source: 'renderer' },
      tail: []
    })

    expect(snapshot.data).toBe('')
    expect(snapshot.start.unavailable).toBeUndefined()
    expect(snapshot.start.seq).toBeUndefined()
    expect(snapshot.start.source).toBeUndefined()
  })

  it('preserves parser carry state when serialized visual data is empty', async () => {
    const snapshot = await subscribeSnapshot({
      connectionId: 'conn-empty-snapshot-parser-tail',
      serialized: {
        data: '',
        cols: 120,
        rows: 40,
        seq: 42,
        source: 'renderer',
        pendingEscapeTailAnsi: '\x1b[38;2;255'
      },
      tail: []
    })

    expect(snapshot.data).toBe('')
    expect(snapshot.start.pendingEscapeTailAnsi).toBe('\x1b[38;2;255')
    expect(snapshot.start.seq).toBeUndefined()
    expect(snapshot.start.source).toBeUndefined()
  })
})
