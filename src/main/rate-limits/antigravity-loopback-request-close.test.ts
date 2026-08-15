import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const { httpRequestMock } = vi.hoisted(() => ({ httpRequestMock: vi.fn() }))

vi.mock('node:http', () => ({ request: httpRequestMock }))

import {
  AntigravityLoopbackResponseError,
  requestAntigravityLoopbackPage
} from './antigravity-loopback-client'

describe('Antigravity loopback request closure', () => {
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
        'Antigravity quota request closed before the response completed'
      )
    )
  })
})
