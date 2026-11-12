import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { app, shell } from 'electron'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import {
  ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS,
  ORCA_CLOUD_CALLBACK_SUCCESS_PAGE
} from './profile-cloud-callback-page'

export type OrcaCloudAuthorizationCode = {
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  state: string
  /**
   * Only with `holdBrowser`: finishes the browser tab, either sending it on to `location` (cloud
   * setup continues in the same tab) or showing the usual "signed in" page when null.
   */
  finishBrowser?: (location: string | null) => void
}

/** How long a held browser tab waits for the caller before it gets the "signed in" page. */
const HOLD_BROWSER_MS = 30_000

/** A sign-in the browser never answers ends after this, with "Sign-in didn’t finish. Try again." */
export const ORCA_CLOUD_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/** Dev automation only (unpackaged): ORCA_CLOUD_SIGN_IN_TIMEOUT_MS shortens the wait for a test run. */
export function orcaCloudSignInTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = app.isPackaged
): number {
  const override = packaged ? Number.NaN : Number(env.ORCA_CLOUD_SIGN_IN_TIMEOUT_MS)
  return Number.isFinite(override) && override >= 1_000 ? override : ORCA_CLOUD_SIGN_IN_TIMEOUT_MS
}

function base64Url(buffer: Buffer): string {
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

export function beginOrcaCloudPkceFlow(
  config: OrcaCloudAuthConfig,
  localProfileId: string,
  options: {
    onAuthorizeUrl?: (url: string) => void
    signal?: AbortSignal
    /** Extra authorize parameters (cloud setup: setup=1, device, setup_steps). */
    authorizeParams?: Record<string, string>
    /** Keep the browser's callback request open until the caller calls finishBrowser. */
    holdBrowser?: boolean
  } = {}
): Promise<OrcaCloudAuthorizationCode> {
  const codeVerifier = createCodeVerifier()
  const nonce = base64Url(randomBytes(32))
  const state = base64Url(randomBytes(32))

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

    function resolveFlow(code: string, held?: ServerResponse): void {
      if (settled) {
        return
      }
      settled = true
      if (!held) {
        resolve({ code, codeVerifier, nonce, redirectUri, state })
        closeServer(server)
        return
      }
      let finished = false
      const finishBrowser = (location: string | null): void => {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(holdTimer)
        // Only an https page may follow a sign-in in the same tab.
        if (location && location.startsWith('https://')) {
          held.writeHead(302, { location, 'cache-control': 'no-store' })
          held.end()
        } else {
          held.writeHead(200, ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS)
          held.end(ORCA_CLOUD_CALLBACK_SUCCESS_PAGE)
        }
        closeServer(server)
      }
      const holdTimer = setTimeout(() => finishBrowser(null), HOLD_BROWSER_MS)
      resolve({ code, codeVerifier, nonce, redirectUri, state, finishBrowser })
    }

    function writeInvalidCallback(response: ServerResponse): void {
      response.writeHead(400)
      response.end('Invalid Orca sign-in response.')
    }

    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/auth/callback') {
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
          response.end(
            cancelled
              ? 'Orca sign-in was cancelled.'
              : 'Orca sign-in failed. Return to Orca and try again.'
          )
          rejectFlow(
            new Error(cancelled ? 'orca_cloud_auth_denied' : 'orca_cloud_auth_callback_failed')
          )
          return
        }
        if (!code) {
          writeInvalidCallback(response)
          return
        }
        if (options.holdBrowser) {
          resolveFlow(code, response)
          return
        }
        response.writeHead(200, ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS)
        response.end(ORCA_CLOUD_CALLBACK_SUCCESS_PAGE)
        resolveFlow(code)
      } catch (error) {
        rejectFlow(error instanceof Error ? error : new Error('orca_cloud_auth_callback_failed'))
      }
    })

    const timeout = setTimeout(() => {
      rejectFlow(new Error('orca_cloud_auth_timeout'))
    }, orcaCloudSignInTimeoutMs())
    const cancel = (): void => rejectFlow(new Error('orca_cloud_auth_cancelled'))
    options.signal?.addEventListener('abort', cancel, { once: true })
    server.once('close', () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', cancel)
    })
    server.once('error', rejectFlow)
    if (options.signal?.aborted) {
      cancel()
      return
    }
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectFlow(new Error('orca_cloud_auth_loopback_unavailable'))
        return
      }
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const authorizeUrl = new URL(config.authorizeEndpoint)
      authorizeUrl.searchParams.set('client_id', config.clientId)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('redirect_uri', redirectUri)
      authorizeUrl.searchParams.set('scope', config.scope)
      authorizeUrl.searchParams.set('nonce', nonce)
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier))
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      authorizeUrl.searchParams.set('local_profile_id', localProfileId)
      for (const [key, value] of Object.entries(options.authorizeParams ?? {})) {
        authorizeUrl.searchParams.set(key, value)
      }
      options.onAuthorizeUrl?.(authorizeUrl.toString())
      // Dev automation only (unpackaged): hand the sign-in URL to a test driver instead of
      // opening the developer's own browser. Same pattern as ORCA_BILLING_DEV_OPEN_URL_FILE.
      const devUrlFile = app.isPackaged
        ? ''
        : (process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE?.trim() ?? '')
      const open = devUrlFile
        ? appendFile(devUrlFile, `${authorizeUrl.toString()}\n`, { mode: 0o600 })
        : shell.openExternal(authorizeUrl.toString())
      void open.catch((error) => {
        rejectFlow(
          error instanceof Error ? error : new Error('orca_cloud_auth_browser_open_failed')
        )
      })
    })
  })
}
