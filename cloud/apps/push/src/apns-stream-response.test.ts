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
  it('resolves with the status and the concatenated body', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, '{"aps":{}}')
    expect(stream.sentBody).toBe('{"aps":{}}')
    stream.emit('response', { ':status': '200' })
    stream.emit('data', Buffer.from('{"re'))
    stream.emit('data', Buffer.from('ason":"ok"}'))
    stream.emit('end')
    await expect(pending).resolves.toEqual({ status: 200, body: '{"reason":"ok"}' })
  })

  it('rejects when the peer resets the stream without an end or an error', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, 'body')
    stream.emit('response', { ':status': '200' })
    // NGHTTP2_NO_ERROR: node emits only 'close', so nothing else would settle.
    stream.emit('close')
    await expect(pending).rejects.toThrow('apns_stream_closed')
  })

  it('keeps the resolved response when close follows a completed end', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, 'body')
    stream.emit('response', { ':status': '410' })
    stream.emit('end')
    stream.emit('close')
    await expect(pending).resolves.toEqual({ status: 410, body: '' })
  })

  it('keeps the original error when close follows a stream error', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, 'body')
    stream.emit('error', new Error('socket_hang_up'))
    stream.emit('close')
    await expect(pending).rejects.toThrow('socket_hang_up')
  })

  it('destroys the stream on timeout and surfaces the timeout error', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, 'body', 10)
    stream.fireTimeout()
    await expect(pending).rejects.toThrow('apns_timeout')
    expect(stream.destroyedWith?.message).toBe('apns_timeout')
  })

  it('reports a missing status header as zero rather than NaN', async () => {
    const stream = fakeApnsStream()
    const pending = readApnsStreamResponse(stream, 'body')
    stream.emit('end')
    await expect(pending).resolves.toEqual({ status: 0, body: '' })
  })
})
