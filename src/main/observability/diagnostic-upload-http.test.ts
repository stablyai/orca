import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn()
}))

vi.mock('node:http', () => ({ request: httpRequestMock }))
vi.mock('node:https', () => ({ request: httpsRequestMock }))

import { postJsonForJson } from './diagnostic-upload-http'

class FakeRequest extends EventEmitter {
  destroy = vi.fn()
  end = vi.fn()
  write = vi.fn()
}

describe('diagnostic upload HTTP', () => {
  it('handles the asynchronous socket error after a request timeout until close', async () => {
    const request = new FakeRequest()
    httpRequestMock.mockReturnValueOnce(request)
    const result = postJsonForJson('http://diagnostics.example/upload', {}, 1000)
    request.emit('timeout')

    await expect(result).rejects.toThrow('diagnostic network request timed out')
    expect(request.destroy).toHaveBeenCalledOnce()
    expect(() => request.emit('error', new Error('socket hang up'))).not.toThrow()
    request.emit('close')
    expect(request.eventNames()).toEqual([])
  })
})
