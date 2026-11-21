import { describe, expect, it, onTestFinished, vi } from 'vitest'
import WebSocket from 'ws'
import type { ModelManager } from './model-manager'
import type * as SonioxProtocol from './soniox-protocol'
import type { SonioxSocket } from './soniox-protocol'
import type { SttEvent } from './stt-service'

const { sockets, readKey } = vi.hoisted(() => {
  const created: FakeSocketLike[] = []
  return {
    sockets: created,
    readKey: { next: (): Promise<string> => Promise.resolve('soniox-key-123456') }
  }
})

type FakeSocketLike = SonioxSocket & {
  open(): void
  frame(payload: unknown): void
  emit(event: string, ...args: unknown[]): void
  sent: (string | Buffer)[]
}

vi.mock('./soniox-api-key-store', () => ({
  readSonioxSpeechApiKey: () => readKey.next()
}))

vi.mock('./soniox-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof SonioxProtocol>()
  return {
    ...actual,
    openSonioxSocket: (): SonioxSocket => {
      const listeners = new Map<string, ((...args: never[]) => void)[]>()
      const emit = (event: string, ...args: unknown[]): void => {
        for (const listener of listeners.get(event) ?? []) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test passes the arguments ws emits for this event
          listener(...(args as never[]))
        }
      }
      const socket: FakeSocketLike = {
        readyState: WebSocket.CONNECTING,
        bufferedAmount: 0,
        sent: [],
        send: (data) => void socket.sent.push(data),
        close: () => undefined,
        terminate: () => undefined,
        on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
        removeAllListeners: () => listeners.clear(),
        open: () => emit('open'),
        emit,
        frame: (payload) => emit('message', Buffer.from(JSON.stringify(payload)), false)
      }
      sockets.push(socket)
      return socket
    }
  }
})

import { createSttSessionState } from './stt-session-state'
import { startSttDictation } from './stt-session-start'
import { stopSttDictation } from './stt-session-stop'

const readyModels = (): ModelManager =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a cloud start only reads getModelState
  ({ getModelState: vi.fn().mockResolvedValue({ id: 'soniox-stt-rt', status: 'ready' }) }) as never

async function startSoniox() {
  const state = createSttSessionState(readyModels(), vi.fn())
  const events: SttEvent[] = []
  await startSttDictation(state, 'soniox-stt-rt', (event) => events.push(event), [], 'phone')
  const socket = sockets.at(-1)!
  socket.open()
  return { state, events, socket }
}

describe('Soniox dictation sessions', () => {
  it('ends a dictation whose stream breaks mid-dictation', async () => {
    const { state, events, socket } = await startSoniox()
    socket.frame({ error_code: 503, error_message: 'busy' })
    expect(events.slice(1)).toEqual([
      { type: 'error', error: 'Soniox error 503: busy' },
      { type: 'stopped' }
    ])
    expect(state.sessions.has('phone')).toBe(false)
  })

  it('reports a failure during Finish once, through the stop', async () => {
    const { state, events, socket } = await startSoniox()
    state.sessions.get('phone')!.cloud!.feedAudio(new Float32Array(160), 16_000)
    const stopped = stopSttDictation(state, 'phone')
    socket.frame({ error_code: 500, error_message: 'boom' })
    await stopped
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', error: 'Soniox error 500: boom' }
    ])
    expect(events.at(-1)).toEqual({ type: 'stopped' })
  })

  it('lands the finalized words, then the error, then stopped when Finish fails', async () => {
    const { state, events, socket } = await startSoniox()
    state.sessions.get('phone')!.cloud!.feedAudio(new Float32Array(160), 16_000)
    const stopped = stopSttDictation(state, 'phone')
    socket.frame({ tokens: [{ text: 'kept words', is_final: true }] })
    socket.emit('close', 1006, Buffer.from(''))
    await stopped
    expect(events.slice(1).filter((event) => event.type !== 'partial')).toEqual([
      { type: 'final', text: 'kept words' },
      { type: 'error', error: 'Soniox closed the stream (1006).' },
      { type: 'stopped' }
    ])
  })

  it('opens no stream when stopped while the key is read', async () => {
    let releaseKey: ((key: string) => void) | null = null
    const readFirstKey = readKey.next
    readKey.next = () => new Promise((resolve) => (releaseKey = resolve))
    onTestFinished(() => {
      readKey.next = readFirstKey
    })
    const state = createSttSessionState(readyModels(), vi.fn())
    const before = sockets.length
    const started = startSttDictation(state, 'soniox-stt-rt', () => undefined, [], 'phone')
    // Stopped while the key is being read: the start must not open a stream once the key arrives.
    await vi.waitFor(() => expect(releaseKey).not.toBeNull())
    await stopSttDictation(state, 'phone')
    releaseKey!('soniox-key-123456')
    await expect(started).rejects.toThrow('dictation_canceled')
    expect(sockets).toHaveLength(before)
  })
})
