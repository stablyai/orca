import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SttEvent } from './stt-service'
import { ElevenLabsTranscriptionSession } from './elevenlabs-transcription-session'

const sockets = vi.hoisted(
  (): {
    items: {
      sent: { commit?: boolean; audio_base_64?: string }[]
      terminated: boolean
      url: URL
      receive: (value: unknown) => void
    }[]
  } => ({ items: [] })
)

vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    default: class extends EventEmitter {
      static OPEN = 1
      readyState = 1
      bufferedAmount = 0
      sent: { commit?: boolean; audio_base_64?: string }[] = []
      terminated = false
      constructor(readonly url: URL) {
        super()
        sockets.items.push(this)
      }
      send(value: string, callback: () => void): void {
        this.sent.push(JSON.parse(value))
        callback()
      }
      terminate(): void {
        this.terminated = true
        this.readyState = 3
        this.emit('close')
      }
      receive(value: unknown): void {
        this.emit('message', Buffer.from(JSON.stringify(value)))
      }
    }
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  sockets.items.length = 0
})
afterEach(() => vi.useRealTimers())

async function start() {
  const events: SttEvent[] = []
  const session = new ElevenLabsTranscriptionSession((event) => events.push(event))
  const ready = session.start('test-only-key')
  const socket = sockets.items[0]
  socket.receive({ message_type: 'session_started' })
  await ready
  return { events, session, socket }
}

describe('ElevenLabs realtime dictation lifetime', () => {
  it('lets Scribe detect the spoken language instead of forcing Korean', async () => {
    const { session, socket } = await start()
    expect(socket.url.searchParams.has('language_code')).toBe(false)
    await session.finish()
  })
  it('replaces partials and emits final text once, without replaying it on stop', async () => {
    const { events, session, socket } = await start()
    session.feedAudio(new Float32Array([-1, 0, 1]), 16000)
    const pcm = Buffer.from(socket.sent[0].audio_base_64 ?? '', 'base64')
    expect(pcm.readInt16LE(0)).toBe(-32768)
    expect(pcm.readInt16LE(4)).toBe(32767)
    socket.receive({ message_type: 'partial_transcript', text: '안녕' })
    socket.receive({ message_type: 'partial_transcript', text: '안녕하세요' })
    socket.receive({ message_type: 'committed_transcript', text: '안녕하세요' })
    expect(await session.finish()).toBe('')
    socket.receive({ message_type: 'committed_transcript', text: 'late' })
    expect(events).toEqual([
      { type: 'partial', text: '안녕' },
      { type: 'partial', text: '안녕하세요' },
      { type: 'final', text: '안녕하세요 ' }
    ])
    expect(socket.terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains the final commit before ending manual capture', async () => {
    const { events, session, socket } = await start()
    session.feedAudio(new Float32Array([0.2]), 16000)
    const stopping = session.finish()
    expect(socket.sent.at(-1)?.commit).toBe(true)
    socket.receive({ message_type: 'committed_transcript', text: '마지막' })
    expect(await stopping).toBe('')
    expect(events).toEqual([{ type: 'final', text: '마지막 ' }])
    expect(socket.terminated).toBe(true)
  })

  it('rejects startup when canceled during connection', async () => {
    const session = new ElevenLabsTranscriptionSession(vi.fn())
    const ready = session.start('test-only-key')
    const rejected = expect(ready).rejects.toThrow('dictation_canceled')
    await session.finish()
    await rejected
    expect(sockets.items[0].terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not leak vendor error bodies or reconnect after quota failure', async () => {
    const { events, session, socket } = await start()
    socket.receive({ message_type: 'quota_exceeded', error: 'test-only-sensitive-text' })
    expect(events).toEqual([{ type: 'error', error: 'elevenlabs_quota_exceeded' }])
    await session.finish()
    expect(sockets.items).toHaveLength(1)
    expect(socket.terminated).toBe(true)
  })

  it('fails closed instead of sending unconfirmed partial text when commit times out', async () => {
    const { session, socket } = await start()
    session.feedAudio(new Float32Array([0.2]), 16000)
    const rejected = expect(session.finish()).rejects.toThrow('elevenlabs_commit_timeout')
    await vi.advanceTimersByTimeAsync(8_000)
    await rejected
    expect(socket.terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an explicitly started conversation open during silence and detects a dead connection', async () => {
    const { session, socket, events } = await start()
    expect(socket.url.searchParams.has('language_code')).toBe(false)
    expect(socket.url.searchParams.get('keepalive_interval_ms')).toBe('5000')
    for (let i = 0; i < 18; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      socket.receive({ message_type: 'partial_transcript', text: '' })
    }
    expect(socket.terminated).toBe(false)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.terminated).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'error', error: 'elevenlabs_connection_timeout' })
    await session.finish()
  })
})
