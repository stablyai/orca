import { Readable, Writable } from 'node:stream'
import { net, type Session } from 'electron'
import { getElectronProxyCredentialsForChallenge } from '../network/electron-proxy-credentials'

const NULL_BODY_STATUSES = [101, 204, 205, 304]

// Pull-driven so an unread body keeps backpressure on the native response.
function toWebBody(response: Readable): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Uint8Array> = response[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await chunks.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    },
    cancel() {
      // Destroy directly: iterator return() would queue behind a pending read on a stalled body.
      response.destroy()
    }
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/**
 * Electron's net.fetch with a proxy `login` listener. Its internal request has none, so
 * Electron cancels every proxy challenge and app 'login' never sees main-process requests.
 * Everything else mirrors Electron 43's net.fetch.
 */
export function fetchWithProxyLogin(request: Request, proxySession: Session): Promise<Response> {
  const { signal } = request
  if (signal.aborted) {
    void request.body?.cancel(abortReason(signal)).catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise((resolve, reject) => {
    const origin = request.headers.get('origin') ?? undefined
    const native = net.request({
      session: proxySession,
      method: request.method,
      url: request.url,
      origin,
      credentials:
        request.credentials === 'same-origin' && !origin ? 'include' : request.credentials,
      cache: request.cache,
      referrerPolicy: request.referrerPolicy,
      redirect: request.redirect
    })
    let aborted = false
    signal.addEventListener(
      'abort',
      () => {
        aborted = true
        reject(abortReason(signal))
        void request.body?.cancel(abortReason(signal)).catch(() => {})
        native.abort()
      },
      { once: true }
    )
    let challenged = false
    native.on('login', (authInfo, callback) => {
      // A repeat challenge means the proxy rejected the credentials; cancel rather than loop.
      const credentials = challenged
        ? null
        : getElectronProxyCredentialsForChallenge(proxySession, authInfo)
      challenged = true
      if (credentials) {
        callback(credentials.username, credentials.password)
      } else {
        callback()
      }
    })
    native.on('response', (response) => {
      if (aborted) {
        return
      }
      if (!(response instanceof Readable)) {
        native.abort()
        reject(new TypeError('Electron response is not a readable stream'))
        return
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const bodyless = NULL_BODY_STATUSES.includes(response.statusCode) || request.method === 'HEAD'
      resolve(
        new Response(bodyless ? null : toWebBody(response), {
          headers,
          status: response.statusCode,
          statusText: response.statusMessage
        })
      )
    })
    native.on('error', reject)
    if (request.mode && (request.mode !== 'cors' || origin)) {
      native.setHeader('Sec-Fetch-Mode', request.mode)
    }
    for (const [key, value] of request.headers) {
      native.setHeader(key, value)
    }
    if (!request.body) {
      native.end()
    } else if (native instanceof Writable) {
      void request.body.pipeTo(Writable.toWeb(native)).then(() => native.end(), reject)
    } else {
      native.abort()
      reject(new TypeError('Electron request is not a writable stream'))
    }
  })
}
