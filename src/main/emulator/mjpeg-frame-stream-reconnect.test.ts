import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeResponseLike = {
  destroy: ReturnType<typeof vi.fn>
  destroyed: boolean
  emit: (eventName: string, ...args: unknown[]) => boolean
}

type FakeRequestLike = {
  destroy: ReturnType<typeof vi.fn>
  destroyed: boolean
  emit: (eventName: string, ...args: unknown[]) => boolean
  respond: (statusCode: number) => FakeResponseLike
}

const requestState = vi.hoisted(() => ({
  requests: [] as FakeRequestLike[]
}))

vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events')

  class FakeResponse extends EventEmitter implements FakeResponseLike {
    destroyed = false
    readonly resume = vi.fn()
    readonly destroy = vi.fn(() => {
      this.destroyed = true
      return this
    })

    constructor(readonly statusCode: number) {
      super()
    }
  }

  class FakeRequest extends EventEmitter implements FakeRequestLike {
    destroyed = false
    private response: FakeResponse | null = null
    readonly end = vi.fn()
    readonly destroy = vi.fn((error?: Error) => {
      if (this.destroyed) {
        return this
      }
      this.destroyed = true
      this.response?.destroy()
      if (error) {
        this.emit('error', error)
      }
      return this
    })

    constructor(private readonly onResponse: (response: FakeResponse) => void) {
      super()
    }

    respond(statusCode: number): FakeResponse {
      const response = new FakeResponse(statusCode)
      this.response = response
      this.onResponse(response)
      return response
    }
  }

  return {
    request: vi.fn(
      (
        _url: unknown,
        _options: unknown,
        onResponse: (response: FakeResponse) => void
      ): FakeRequest => {
        const request = new FakeRequest(onResponse)
        requestState.requests.push(request)
        return request
      }
    )
  }
})

import { MjpegFrameStream } from './mjpeg-frame-stream'

const JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
const streams: MjpegFrameStream[] = []

function makeStream() {
  const callbacks = {
    onError: vi.fn(),
    onFrame: vi.fn()
  }
  const stream = new MjpegFrameStream('http://127.0.0.1:3100/stream.mjpeg', callbacks)
  streams.push(stream)
  return { callbacks, stream }
}

beforeEach(() => {
  vi.useFakeTimers()
  requestState.requests.length = 0
})

afterEach(() => {
  for (const stream of streams) {
    stream.stop()
  }
  streams.length = 0
  vi.useRealTimers()
})

describe('MjpegFrameStream reconnect ownership', () => {
  it('closes an endless error response before reconnecting and ignores stale errors', () => {
    const { callbacks, stream } = makeStream()
    stream.start()
    stream.start()
    expect(requestState.requests).toHaveLength(1)

    const firstRequest = requestState.requests[0]
    const errorResponse = firstRequest.respond(503)
    expect(firstRequest.destroyed).toBe(true)
    expect(errorResponse.destroyed).toBe(true)
    expect(callbacks.onError).toHaveBeenCalledWith('Simulator stream returned HTTP 503.')

    vi.runOnlyPendingTimers()
    expect(requestState.requests).toHaveLength(2)

    firstRequest.emit('error', new Error('late failure'))
    vi.runOnlyPendingTimers()
    expect(requestState.requests).toHaveLength(2)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)

    requestState.requests[1].emit('timeout')
    expect(callbacks.onError).toHaveBeenLastCalledWith('Simulator stream timed out.')
    stream.stop()
    vi.runOnlyPendingTimers()
    expect(requestState.requests).toHaveLength(2)
  })

  it('delivers a valid response and reconnects once after it ends', () => {
    const { callbacks, stream } = makeStream()
    stream.start()
    const firstRequest = requestState.requests[0]
    const response = firstRequest.respond(200)

    response.emit('data', JPEG)
    expect(callbacks.onFrame).toHaveBeenCalledWith(JPEG)

    response.emit('end')
    expect(firstRequest.destroyed).toBe(true)
    vi.runOnlyPendingTimers()
    expect(requestState.requests).toHaveLength(2)

    response.emit('error', new Error('late response error'))
    vi.runOnlyPendingTimers()
    expect(requestState.requests).toHaveLength(2)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('destroys a response that arrives after its request is stale', () => {
    const { callbacks, stream } = makeStream()
    stream.start()
    const firstRequest = requestState.requests[0]

    firstRequest.emit('error', new Error('connection reset'))
    vi.runOnlyPendingTimers()
    expect(requestState.requests).toHaveLength(2)

    const staleResponse = firstRequest.respond(200)
    staleResponse.emit('data', JPEG)
    expect(staleResponse.destroyed).toBe(true)
    expect(callbacks.onFrame).not.toHaveBeenCalled()
  })
})
