import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { httpRequestMock } = vi.hoisted(() => ({ httpRequestMock: vi.fn() }))

vi.mock('node:http', () => ({ request: httpRequestMock }))

import {
  AntigravityLoopbackResponseError,
  requestAntigravityLoopbackPage
} from './antigravity-loopback-client'

describe('Antigravity loopback request closure', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects when the request closes without a response event', async () => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void
      end: () => void
    }
    request.destroy = (error?: Error) => {
      if (error) {
        request.emit('error', error)
      }
      request.emit('close')
    }
    request.end = () => queueMicrotask(() => request.emit('close'))
    httpRequestMock.mockReturnValueOnce(request)

    await expect(
      requestAntigravityLoopbackPage(
        'http:',
        40_200,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
        new AbortController().signal
      )
    ).rejects.toThrow(
      new AntigravityLoopbackResponseError(
        'Antigravity quota request closed before the response completed',
        false
      )
    )
  })

  it('enforces a wall-clock deadline after a response starts', async () => {
    vi.useFakeTimers()
    const response = Object.assign(new EventEmitter(), { statusCode: 200 })
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void
      end: () => void
    }
    const destroy = vi.fn((error?: Error) => {
      if (error) {
        request.emit('error', error)
      }
      request.emit('close')
    })
    request.destroy = destroy
    request.end = () => undefined
    httpRequestMock.mockImplementationOnce(
      (_options: unknown, onResponse: (value: EventEmitter & { statusCode: number }) => void) => {
        queueMicrotask(() => {
          onResponse(response)
          response.emit('data', Buffer.from('{'))
        })
        return request
      }
    )

    const result = requestAntigravityLoopbackPage(
      'http:',
      40_200,
      '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      new AbortController().signal
    )
    const rejection = expect(result).rejects.toMatchObject({
      name: 'AntigravityLoopbackResponseError',
      message: 'Antigravity quota response timed out',
      responseCompleted: false
    })
    await vi.advanceTimersByTimeAsync(1_249)
    expect(destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await rejection
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('clears the wall-clock deadline after an early close', async () => {
    vi.useFakeTimers()
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void
      end: () => void
    }
    const destroy = vi.fn()
    request.destroy = destroy
    request.end = () => queueMicrotask(() => request.emit('close'))
    httpRequestMock.mockReturnValueOnce(request)

    const result = requestAntigravityLoopbackPage(
      'http:',
      40_200,
      '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      new AbortController().signal
    )
    await expect(result).rejects.toThrow(
      new AntigravityLoopbackResponseError(
        'Antigravity quota request closed before the response completed',
        false
      )
    )
    await vi.advanceTimersByTimeAsync(1_250)

    expect(destroy).not.toHaveBeenCalled()
  })
})
