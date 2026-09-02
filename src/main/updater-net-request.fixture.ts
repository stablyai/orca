import { EventEmitter } from 'node:events'
import { vi, type Mock } from 'vitest'

type NetFetchResponse = {
  ok?: boolean
  status?: number
}

export function installNetRequestFetchAdapter(netRequestMock: Mock, netFetchMock: Mock): void {
  netRequestMock.mockImplementation(
    (options: { method?: string; redirect?: string; url: string }) => {
      const request = new EventEmitter() as EventEmitter & {
        abort: Mock
        end: Mock
      }
      request.abort = vi.fn()
      request.end = vi.fn(() => {
        Promise.resolve(
          netFetchMock(options.url, { method: options.method, redirect: options.redirect })
        ).then(
          (response: NetFetchResponse) => {
            const status = response.status ?? (response.ok ? 200 : 503)
            if (options.redirect === 'manual' && status >= 300 && status < 400) {
              request.emit('redirect', status, options.method ?? 'GET', 'https://redirect.test', {})
              // Why: Electron cancels an unfollowed manual redirect and then emits 'error'.
              request.emit('error', new Error('Redirect was cancelled'))
            } else {
              request.emit('response', { statusCode: status })
            }
          },
          (error) => request.emit('error', error)
        )
        return request
      })
      return request
    }
  )
}
