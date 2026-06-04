import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn()
}))

vi.mock('node:http', () => ({ request: httpRequestMock }))
vi.mock('node:https', () => ({ request: httpsRequestMock }))

import { MAX_RESPONSE_BYTES, postJsonForJson } from './diagnostic-upload-http'

class FakeRequest extends EventEmitter {
  destroy = vi.fn()
  end = vi.fn()
  write = vi.fn()
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  destroy = vi.fn()
}

describe('diagnostic upload HTTP', () => {
  it('removes request and response listeners after a successful response', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })

    const result = postJsonForJson('http://diagnostics.example/upload', { ok: true }, 1000)
    response.emit('data', Buffer.from('{"accepted":true}'))
    response.emit('end')

    await expect(result).resolves.toEqual({ accepted: true })
    expect(request.listenerCount('error')).toBe(0)
    expect(request.listenerCount('timeout')).toBe(0)
    expect(response.listenerCount('data')).toBe(0)
    expect(response.listenerCount('end')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })

  it('removes listeners after rejecting an oversized response', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })

    const result = postJsonForJson('http://diagnostics.example/upload', { ok: true }, 1000)
    response.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1))

    await expect(result).rejects.toThrow('diagnostic response exceeded size limit')
    expect(request.destroy).toHaveBeenCalledTimes(1)
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(request.listenerCount('error')).toBe(0)
    expect(request.listenerCount('timeout')).toBe(0)
    expect(response.listenerCount('data')).toBe(0)
    expect(response.listenerCount('end')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })
})
