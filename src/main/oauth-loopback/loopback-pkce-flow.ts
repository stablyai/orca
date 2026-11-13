import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { shell } from 'electron'
import {
  LOOPBACK_CALLBACK_RESPONSE_HEADERS,
  renderLoopbackCallbackSuccessPage
} from './loopback-callback-page'

export type LoopbackAuthorizationCode = {
  code: string
  codeVerifier: string
  redirectUri: string
  state: string
}

export type LoopbackPkceFlowConfig = {
  /** Exact path the authorization server redirects back to, e.g. `/auth/callback`. */
  callbackPath: string
  /** Prefix for rejection messages: `${prefix}_denied`, `_timeout`, `_cancelled`, … */
  errorPrefix: string
  /** Shown in the browser tab: the success page title and the plain-text error replies. */
  browserCopy: { success: string; invalid: string; cancelled: string; failed: string }
  buildAuthorizeUrl: (request: {
    redirectUri: string
    state: string
    codeChallenge: string
  }) => string
}

export type LoopbackPkceFlowOptions = {
  onAuthorizeUrl?: (url: string) => void
  signal?: AbortSignal
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000

export function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

function closeServer(server: Server): void {
  try {
    // Browser keep-alive sockets can delay close and timeout cleanup.
    server.closeAllConnections?.()
    server.close()
  } catch {
    // Already closed.
  }
}

/** RFC 8252 authorization code + PKCE (S256) through a one-shot 127.0.0.1 listener. */
export function beginLoopbackPkceFlow(
  config: LoopbackPkceFlowConfig,
  options: LoopbackPkceFlowOptions = {}
): Promise<LoopbackAuthorizationCode> {
  const codeVerifier = createCodeVerifier()
  const state = base64Url(randomBytes(32))
  const fail = (reason: string): Error => new Error(`${config.errorPrefix}_${reason}`)

  return new Promise((resolve, reject) => {
    let settled = false
    let redirectUri = ''

    function rejectFlow(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      reject(error)
      closeServer(server)
    }

    function resolveFlow(code: string): void {
      if (settled) {
        return
      }
      settled = true
      resolve({ code, codeVerifier, redirectUri, state })
      closeServer(server)
    }

    function writeInvalidCallback(response: ServerResponse): void {
      response.writeHead(400)
      response.end(config.browserCopy.invalid)
    }

    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== config.callbackPath) {
          response.writeHead(404)
          response.end('Not found')
          return
        }
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        if (returnedState !== state) {
          // Stray loopback probes must not cancel the user’s login.
          writeInvalidCallback(response)
          return
        }
        if (url.searchParams.has('error')) {
          const cancelled = url.searchParams.get('error') === 'access_denied'
          response.writeHead(400)
          response.end(cancelled ? config.browserCopy.cancelled : config.browserCopy.failed)
          rejectFlow(fail(cancelled ? 'denied' : 'callback_failed'))
          return
        }
        if (!code) {
          writeInvalidCallback(response)
          return
        }
        response.writeHead(200, LOOPBACK_CALLBACK_RESPONSE_HEADERS)
        response.end(renderLoopbackCallbackSuccessPage(config.browserCopy.success))
        resolveFlow(code)
      } catch (error) {
        rejectFlow(error instanceof Error ? error : fail('callback_failed'))
      }
    })

    const timeout = setTimeout(() => {
      rejectFlow(fail('timeout'))
    }, AUTH_TIMEOUT_MS)
    const cancel = (): void => rejectFlow(fail('cancelled'))
    options.signal?.addEventListener('abort', cancel, { once: true })
    server.once('close', () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', cancel)
    })
    server.once('error', rejectFlow)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectFlow(fail('loopback_unavailable'))
        return
      }
      redirectUri = `http://127.0.0.1:${address.port}${config.callbackPath}`
      const authorizeUrl = config.buildAuthorizeUrl({
        redirectUri,
        state,
        codeChallenge: createCodeChallenge(codeVerifier)
      })
      options.onAuthorizeUrl?.(authorizeUrl)
      void shell.openExternal(authorizeUrl).catch((error) => {
        rejectFlow(error instanceof Error ? error : fail('browser_open_failed'))
      })
    })
  })
}
