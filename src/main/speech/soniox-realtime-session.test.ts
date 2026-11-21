import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { SttEvent } from './stt-service'
import {
  SONIOX_ACCEPT_TIMEOUT_MS,
  SONIOX_FINISH_TIMEOUT_MS,
  SonioxRealtimeSession
} from './soniox-realtime-session'
import { sonioxStreamConfig, type SonioxSocket } from './soniox-protocol'
import { checkSonioxApiKey } from './soniox-key-verification'

class FakeSocket implements SonioxSocket {
  private readonly listeners = new Map<string, ((...args: never[]) => void)[]>()
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0
  sent: (string | Buffer)[] = []
  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  removeAllListeners(): this {
    this.listeners.clear()
    return this
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test passes the arguments ws emits for this event
      listener(...(args as never[]))
    }
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0
  }
  send(data: string | Buffer): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = WebSocket.CLOSED
  }
  terminate(): void {
    this.readyState = WebSocket.CLOSED
  }
  open(): void {
    this.readyState = WebSocket.OPEN
    this.emit('open')
  }
  frame(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)), false)
  }
}

async function setup(apiKey = 'soniox-test-key-123', isCanceled = () => false) {
  const socket = new FakeSocket()
  const opened: FakeSocket[] = []
  const events: SttEvent[] = []
  const failures: string[] = []
  const session = new SonioxRealtimeSession({
    readApiKey: async () => apiKey,
    language: 'uk',
    terms: ['Orca'],
    sink: (event) => events.push(event),
    onFailure: (error) => failures.push(error),
    isCanceled,
    openSocket: () => {
      opened.push(socket)
      return socket
    }
  })
  await session.start()
  return { socket, events, failures, session, opened }
}

const token = (text: string, final: boolean) => ({ text, is_final: final })

afterEach(() => {
  vi.useRealTimers()
})

describe('SonioxRealtimeSession', () => {
  it('queues audio until the stream opens, then sends the config first', async () => {
    const { socket, session } = await setup()
    session.feedAudio(new Float32Array(160), 16_000)
    expect(socket.sent).toHaveLength(0)
    socket.open()
    expect(JSON.parse(String(socket.sent[0]))).toEqual(sonioxStreamConfig('uk', ['Orca']))
    expect(Buffer.isBuffer(socket.sent[1])).toBe(true)
    expect(socket.sent[1]).toHaveLength(320)
  })

  it('streams partials and commits finalized text at each pause', async () => {
    const { socket, events } = await setup()
    socket.open()
    socket.frame({ tokens: [token('Hello', true), token(' wor', false)] })
    socket.frame({ tokens: [token(' world', true), token('<end>', true)] })
    socket.frame({ tokens: [token(' next', false)] })
    expect(events).toEqual([
      { type: 'partial', text: 'Hello wor' },
      { type: 'final', text: 'Hello world' },
      { type: 'partial', text: 'next' }
    ])
  })

  it('returns the text after the last pause once Soniox finishes', async () => {
    const { socket, session, events } = await setup()
    socket.open()
    session.feedAudio(new Float32Array(160), 16_000)
    socket.frame({
      tokens: [token('one', true), token('<end>', true), token(' two', false)]
    })
    const finished = session.finish()
    // The end frame is an empty text frame.
    expect(socket.sent.at(-1)).toBe('')
    socket.frame({
      tokens: [token(' two', true), token('<fin>', true)],
      finished: true
    })
    await expect(finished).resolves.toBe('two')
    expect(events.filter((e) => e.type === 'final')).toEqual([{ type: 'final', text: 'one' }])
  })

  it('ends a dictation whose stream breaks before stop, redacting the key', async () => {
    const { socket, failures, events } = await setup('secret-key-abcdef')
    socket.open()
    socket.frame({
      error_code: 401,
      error_message: 'bad key secret-key-abcdef'
    })
    expect(failures).toEqual(['Soniox rejected the API key (401). bad key [redacted]'])
    expect(events).toEqual([])
    expect(socket.listenerCount('message')).toBe(0)
  })

  it('treats a close before the end frame as a failure', async () => {
    const { socket, failures } = await setup()
    socket.open()
    socket.emit('close', 1000, Buffer.from('session limit'))
    expect(failures).toEqual(['Soniox closed the stream (1000: session limit).'])
  })

  it('reports a failure during finish through finish, not onFailure', async () => {
    const { socket, session, failures } = await setup()
    socket.open()
    session.feedAudio(new Float32Array(160), 16_000)
    const finished = session.finish()
    socket.frame({ error_code: 500, error_message: 'boom' })
    await expect(finished).rejects.toThrow('Soniox error 500: boom')
    expect(failures).toEqual([])
  })

  it('reports a stream that never finishes, landing its finalized words first', async () => {
    vi.useFakeTimers()
    const { socket, session, events } = await setup()
    socket.open()
    session.feedAudio(new Float32Array(160), 16_000)
    socket.frame({ tokens: [token('partly', true), token(' maybe', false)] })
    const finished = session.finish()
    const outcome = expect(finished).rejects.toThrow('the end may be missing')
    await vi.advanceTimersByTimeAsync(SONIOX_FINISH_TIMEOUT_MS)
    await outcome
    expect(events.at(-1)).toEqual({ type: 'final', text: 'partly' })
  })

  it('waits longer when audio is still in the send buffer at stop', async () => {
    vi.useFakeTimers()
    const { socket, session } = await setup()
    socket.open()
    session.feedAudio(new Float32Array(160), 16_000)
    socket.bufferedAmount = 125_000
    const finished = session.finish()
    await vi.advanceTimersByTimeAsync(SONIOX_FINISH_TIMEOUT_MS)
    socket.frame({ tokens: [token('late', true)], finished: true })
    await expect(finished).resolves.toBe('late')
  })

  it('gives audio queued before the stream opened time to go out at stop', async () => {
    vi.useFakeTimers()
    const { socket, session } = await setup()
    // 4 s of audio queued while the socket opens: 128 KB, about a second at the upload rate.
    session.feedAudio(new Float32Array(4 * 16_000), 16_000)
    const finished = session.finish()
    socket.open()
    await vi.advanceTimersByTimeAsync(SONIOX_FINISH_TIMEOUT_MS)
    socket.frame({ tokens: [token('queued', true)], finished: true })
    await expect(finished).resolves.toBe('queued')
  })

  it('says the stream never started when it was still opening at the finish deadline', async () => {
    vi.useFakeTimers()
    const { session } = await setup()
    session.feedAudio(new Float32Array(160), 16_000)
    const outcome = expect(session.finish()).rejects.toThrow(
      'Soniox did not start the stream in time.'
    )
    // The deadline adds a few ms for the queued audio.
    await vi.advanceTimersByTimeAsync(SONIOX_FINISH_TIMEOUT_MS + 1000)
    await outcome
  })

  it('fails a stream that closes after the end frame without finishing', async () => {
    const { socket, session } = await setup()
    socket.open()
    session.feedAudio(new Float32Array(160), 16_000)
    const finished = session.finish()
    socket.emit('close', 1006, Buffer.from(''))
    await expect(finished).rejects.toThrow('Soniox closed the stream (1006).')
  })

  it('lands finalized words before ending a stream that breaks mid-dictation', async () => {
    const { socket, events, failures } = await setup()
    socket.open()
    socket.frame({ tokens: [token('kept', true), token(' lost', false)] })
    socket.emit('close', 1000, Buffer.from('session limit'))
    expect(events.at(-1)).toEqual({ type: 'final', text: 'kept' })
    expect(failures).toHaveLength(1)
  })

  it('commits each phrase separately when one frame carries two', async () => {
    const { socket, events } = await setup()
    socket.open()
    socket.frame({
      tokens: [token('one', true), token('<end>', true), token(' two', true), token('<end>', true)]
    })
    expect(events.filter((e) => e.type === 'final')).toEqual([
      { type: 'final', text: 'one' },
      { type: 'final', text: 'two' }
    ])
  })

  it('returns no text when canceled during finish', async () => {
    const { socket, session } = await setup()
    socket.open()
    session.feedAudio(new Float32Array(160), 16_000)
    socket.frame({ tokens: [token('dropped', true)] })
    const finished = session.finish()
    session.cancel()
    await expect(finished).resolves.toBe('')
  })

  it('opens no stream when the dictation was stopped while the key was read', async () => {
    const { opened } = await setup('key', () => true)
    expect(opened).toHaveLength(0)
  })

  it('fails when the stream does not open in time', async () => {
    vi.useFakeTimers()
    const { failures } = await setup()
    await vi.advanceTimersByTimeAsync(SONIOX_ACCEPT_TIMEOUT_MS)
    expect(failures).toEqual(['Soniox did not start the stream in time.'])
  })

  it('sends queued audio and the end frame when stop comes before the stream opens', async () => {
    const { socket, session } = await setup()
    session.feedAudio(new Float32Array(160), 16_000)
    const finished = session.finish()
    socket.open()
    expect(socket.sent.map((data) => (typeof data === 'string' ? data : 'pcm'))).toEqual([
      JSON.stringify(sonioxStreamConfig('uk', ['Orca'])),
      'pcm',
      ''
    ])
    socket.frame({ tokens: [token('hi', true)], finished: true })
    await expect(finished).resolves.toBe('hi')
  })

  it('fails a dictation whose socket cannot keep up', async () => {
    const { socket, session, failures } = await setup()
    socket.open()
    socket.bufferedAmount = 2 * 1024 * 1024
    session.feedAudio(new Float32Array(160), 16_000)
    expect(failures).toEqual(['Soniox connection is too slow.'])
  })

  it('reports a key Soniox refuses at the handshake', async () => {
    const { socket, failures } = await setup()
    const request = { destroy: vi.fn() }
    socket.emit('unexpected-response', request, { statusCode: 402 })
    expect(request.destroy).toHaveBeenCalled()
    expect(failures).toEqual(['Soniox refused this API key (402).'])
  })

  it('stops taking audio at the 10-minute cap', async () => {
    const { socket, session } = await setup()
    socket.open()
    const tenMinutes = new Float32Array(10 * 60 * 16_000)
    expect(session.feedAudio(tenMinutes, 16_000)).toBe(true)
    const sent = socket.sent.length
    expect(session.feedAudio(new Float32Array(160), 16_000)).toBe(false)
    expect(socket.sent).toHaveLength(sent)
  })

  it('returns nothing and sends no end frame when no audio came', async () => {
    const { socket, session } = await setup()
    socket.open()
    await expect(session.finish()).resolves.toBe('')
    expect(socket.sent).toHaveLength(1)
  })
})

describe('checkSonioxApiKey', () => {
  it('accepts a key once Soniox finishes the probe stream', async () => {
    const socket = new FakeSocket()
    const result = checkSonioxApiKey('k', () => socket)
    socket.open()
    socket.frame({ tokens: [], finished: true })
    await expect(result).resolves.toBeNull()
  })

  it('refuses a key Soniox rejects', async () => {
    const socket = new FakeSocket()
    const result = checkSonioxApiKey('k', () => socket)
    socket.open()
    socket.frame({
      error_code: 401,
      error_type: 'unauthenticated',
      error_message: 'Invalid'
    })
    await expect(result).resolves.toBe('Soniox rejected the API key (401). Invalid')
  })

  it('refuses a key Soniox turns away at the handshake', async () => {
    const socket = new FakeSocket()
    const result = checkSonioxApiKey('k', () => socket)
    const request = { destroy: vi.fn() }
    socket.emit('unexpected-response', request, { statusCode: 401 })
    await expect(result).resolves.toBe('Soniox rejected the API key (401).')
    expect(request.destroy).toHaveBeenCalled()
  })

  it('lets an unreachable Soniox save the key anyway', async () => {
    const socket = new FakeSocket()
    const result = checkSonioxApiKey('k', () => socket)
    socket.emit('error', new Error('ENOTFOUND'))
    await expect(result).resolves.toBeNull()
  })
})
