import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { readApnsStreamResponse, type ApnsResponseStream } from './apns-stream-response.js'

type FakeStream = ApnsResponseStream & {
  sentBody: string | null
  destroyedWith: Error | null
  fireTimeout(): void
}

function fakeApnsStream(): FakeStream {
  const emitter = new EventEmitter() as FakeStream
  emitter.sentBody = null
  emitter.destroyedWith = null
  let onTimeout: (() => void) | null = null
  emitter.setTimeout = (_ms, callback) => {
    onTimeout = callback
  }
  emitter.destroy = (error?: Error) => {
    emitter.destroyedWith = error ?? null
    if (error) emitter.emit('error', error)
  }
  emitter.end = (body: string) => {
    emitter.sentBody = body
  }
  emitter.fireTimeout = () => onTimeout?.()
  return emitter
}

describe('apns stream response', () => {
  it('rejects when the peer resets the stream without an end or an error', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, 'body')
    stream.emit('response', { ':status': '200' })
    // NGHTTP2_NO_ERROR: node emits only 'close', so nothing else would settle.
    stream.emit('close')
    await expect(pending).rejects.toThrow('apns_stream_closed')
  })
})
