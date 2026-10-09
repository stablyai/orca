// Request normalization follows Electron 43.7.5 net-fetch.ts; see resources/licenses/electron/LICENSE-MIT.
import { Readable, Writable } from 'node:stream'
import { net, type Session } from 'electron'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { getElectronProxyCredentialsForChallenge } from '../network/electron-proxy-credentials'
import { getProxySessionApplicationReadiness } from '../network/proxy-settings'

export function fetchElectronProxyRequest(
  request: Request,
  proxySession: Session
): Promise<Response> {
  if (request.signal.aborted) {
    return Promise.reject(
      request.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    )
  }
  return new Promise((resolve, reject) => {
    const origin = request.headers.get('origin') ?? undefined
    const credentials =
      request.credentials === 'same-origin' && !origin ? 'include' : request.credentials
    const native = net.request({
      session: proxySession,
      method: request.method,
      url: request.url,
      origin,
      credentials,
      cache: request.cache,
      referrerPolicy: request.referrerPolicy,
      redirect: request.redirect
    })
    let finished = false
    let bodyClosed = false
    let credentialsSent = false
    let nativeAborted = false
    let upload: Writable | undefined
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    let cancelBody: ((reason: unknown) => Promise<void>) | undefined
    const abortNative = (): void => {
      if (!nativeAborted) {
        nativeAborted = true
        native.abort()
      }
    }
    const cleanup = (): void => request.signal.removeEventListener('abort', onAbort)
    const fail = (error: unknown): void => {
      if (finished) {
        return
      }
      finished = true
      cleanup()
      reject(error)
      if (bodyController && !bodyClosed) {
        bodyClosed = true
        bodyController.error(error)
      }
      abortNative()
      upload?.destroy(error instanceof Error ? error : new Error('Request body cancelled'))
      void cancelBody?.(error).catch(() => {})
    }
    const onAbort = (): void => {
      if (bodyController && !bodyClosed) {
        cleanup()
        abortNative()
      } else {
        fail(request.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      }
    }
    request.signal.addEventListener('abort', onAbort, { once: true })
    native.on('error', fail)
    native.on('login', (authInfo, callback) => {
      let answered = false
      const respond = (...values: [username?: string, password?: string]): void => {
        if (answered) {
          return
        }
        answered = true
        try {
          callback(...values)
        } catch (error) {
          fail(error)
        }
      }
      const answer = (ready: boolean): void => {
        const matched = ready
          ? getElectronProxyCredentialsForChallenge(proxySession, authInfo)
          : null
        if (finished || request.signal.aborted || credentialsSent || !matched) {
          respond()
          return
        }
        credentialsSent = true
        respond(matched.username, matched.password)
      }
      const readiness = getProxySessionApplicationReadiness(proxySession)
      if (typeof readiness === 'boolean') {
        answer(readiness)
      } else {
        void waitForPromiseWithSignal(readiness, request.signal).then(answer, () => respond())
      }
    })
    native.on('response', (incoming) => {
      if (finished) {
        return
      }
      try {
        if (!(incoming instanceof Readable)) {
          throw new TypeError('Electron response is not a readable stream')
        }
        incoming.on('error', fail)
        const headers = new Headers()
        for (const [key, value] of Object.entries(incoming.headers)) {
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const bodyless =
          request.method === 'HEAD' || [101, 204, 205, 304].includes(incoming.statusCode)
        let body: ReadableStream<Uint8Array> | null = null
        if (bodyless) {
          incoming.resume()
          incoming.once('end', () => {
            finished = true
            cleanup()
          })
        } else {
          const reader = Readable.toWeb(incoming, {
            strategy: {
              highWaterMark: incoming.readableHighWaterMark,
              size: (chunk: Uint8Array) => chunk.byteLength
            }
          }).getReader()
          cancelBody = (reason) => reader.cancel(reason)
          body = new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller
            },
            async pull(controller) {
              try {
                const { done, value } = await reader.read()
                if (bodyClosed) {
                  return
                }
                if (done) {
                  bodyClosed = true
                  finished = true
                  cleanup()
                  controller.close()
                  reader.releaseLock()
                } else if (value instanceof Uint8Array) {
                  controller.enqueue(value)
                } else {
                  throw new TypeError('Electron response chunk is not binary')
                }
              } catch (error) {
                fail(error)
              }
            },
            async cancel(reason) {
              bodyClosed = true
              finished = true
              cleanup()
              abortNative()
              await reader.cancel(reason)
            }
          })
        }
        resolve(
          new Response(body, {
            headers,
            status: incoming.statusCode,
            statusText: incoming.statusMessage
          })
        )
      } catch (error) {
        fail(error)
      }
    })
    try {
      if (request.mode !== 'cors' || origin) {
        native.setHeader('Sec-Fetch-Mode', request.mode)
      }
      for (const [key, value] of request.headers) {
        native.setHeader(key, value)
      }
      if (request.signal.aborted) {
        onAbort()
      } else if (request.body) {
        // Keep Electron's buffered upload replay; chunked bodies cannot replay redirects.
        upload = new Writable({
          write(chunk: Buffer, encoding, callback) {
            native.write(chunk, encoding, callback)
          },
          final(callback) {
            native.end(undefined, undefined, callback)
          },
          destroy(error, callback) {
            if (error) {
              abortNative()
            }
            callback(error)
          }
        })
        upload.on('error', fail)
        void request.body.pipeTo(Writable.toWeb(upload)).catch(fail)
      } else {
        native.end()
      }
    } catch (error) {
      fail(error)
    }
  })
}
