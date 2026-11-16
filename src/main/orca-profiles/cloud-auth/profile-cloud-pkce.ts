import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { app, shell } from 'electron'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import {
  ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS,
  orcaCloudCallbackPage,
  type OrcaCloudCallbackOutcome
} from './profile-cloud-callback-page'
import { ORCA_CLOUD_AUTH_SSO_REQUIRED_ERROR } from '../../../shared/orca-profile-reconnect-reason'

export type OrcaCloudAuthorizationCode = {
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  state: string
  /** Answers the waiting browser tab once Orca knows whether sign-in finished. */
  respond: (outcome: OrcaCloudCallbackOutcome) => void
  /**
   * Cloud setup: answers the waiting tab by sending it on to `location` instead (setup continues in
   * the same tab). Only an https page may follow a sign-in; anything else gets the "signed in" page.
   */
  redirect: (location: string) => void
}

/** A sign-in the browser never answers ends after this, with "Sign-in didn’t finish. Try again." */
export const ORCA_CLOUD_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
// Longer than the code exchange request timeout, so the app normally answers first.
const BROWSER_RESPONSE_TIMEOUT_MS = 45 * 1000

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
    /**
     * COPY-LINK-FIRST-CLICK: false starts the same flow without opening the browser (the person
     * copied the link to paste into a private window). The listener and its timeout are unchanged,
     * so an unused link ends like an unanswered click.
     */
    openBrowser?: boolean
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

    function resolveFlow(code: string, response: ServerResponse): void {
      if (settled) {
        return
      }
      settled = true
      // Stop accepting callbacks but keep this response open until the app answers.
      server.close()
      let answered = false
      const answer = (write: () => void): void => {
        if (answered) {
          return
        }
        answered = true
        clearTimeout(responseTimeout)
        write()
        closeServer(server)
      }
      const respond = (outcome: OrcaCloudCallbackOutcome): void =>
        answer(() => {
          response.writeHead(
            outcome.status === 'failed' ? 500 : 200,
            ORCA_CLOUD_CALLBACK_RESPONSE_HEADERS
          )
          response.end(orcaCloudCallbackPage(outcome))
        })
      const redirect = (location: string): void => {
        if (!location.startsWith('https://')) {
          respond({ status: 'connected' })
          return
        }
        answer(() => {
          response.writeHead(302, { location, 'cache-control': 'no-store' })
          response.end()
        })
      }
      const responseTimeout = setTimeout(
        () => respond({ status: 'failed', error: 'orca_cloud_auth_response_timeout' }),
        BROWSER_RESPONSE_TIMEOUT_MS
      )
      resolve({
        code,
        codeVerifier,
        nonce,
        redirectUri,
        state,
        respond,
        redirect
      })
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
          const reason = url.searchParams.get('error')
          const cancelled = reason === 'access_denied'
          // The team requires single sign-on and this sign-in came another way.
          const ssoRequired = reason === 'sso_required'
          response.writeHead(400)
          response.end(
            cancelled
              ? 'Orca sign-in was cancelled.'
              : ssoRequired
                ? 'Your team requires single sign-on. Return to Orca, sign in again and choose Sign in with SSO.'
                : 'Orca sign-in failed. Return to Orca and try again.'
          )
          rejectFlow(
            new Error(
              cancelled
                ? 'orca_cloud_auth_denied'
                : ssoRequired
                  ? ORCA_CLOUD_AUTH_SSO_REQUIRED_ERROR
                  : 'orca_cloud_auth_callback_failed'
            )
          )
          return
        }
        if (!code) {
          writeInvalidCallback(response)
          return
        }
        resolveFlow(code, response)
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
      // A plain sign-in asks auth for its branded "Sign in to Orca" page (V3-04); servers
      // that don't know the flag ignore it. Cloud setup passes its own parameters.
      for (const [key, value] of Object.entries(options.authorizeParams ?? { signin_page: '1' })) {
        authorizeUrl.searchParams.set(key, value)
      }
      options.onAuthorizeUrl?.(authorizeUrl.toString())
      // Dev automation only (unpackaged): hand the sign-in URL to a test driver instead of
      // opening the developer's own browser. Same pattern as ORCA_BILLING_DEV_OPEN_URL_FILE.
      const devUrlFile = app.isPackaged
        ? ''
        : (process.env.ORCA_CLOUD_DEV_OPEN_URL_FILE?.trim() ?? '')
      const open =
        options.openBrowser === false
          ? Promise.resolve()
          : devUrlFile
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

/** COPY-LINK-FIRST-CLICK: `openBrowser: false` starts sign-in without opening the browser. */
export type ConnectCurrentArgs = { openBrowser?: boolean }

/** The renderer's connect args: only an explicit `openBrowser: false` suppresses the browser. */
export function connectCurrentArgsFromUnknown(args: unknown): ConnectCurrentArgs {
  const openBrowser =
    typeof args === 'object' && args !== null
      ? Object.getOwnPropertyDescriptor(args, 'openBrowser')?.value
      : undefined
  return openBrowser === false ? { openBrowser: false } : {}
}

/**
 * The PKCE options a sign-in passes: cloud setup's parameters, or a plain sign-in that
 * may skip the browser (COPY-LINK-FIRST-CLICK; setup asks for that on its own `connect` args).
 */
export function pkceSignInOptions(
  setup: ({ authorizeParams?: Record<string, string> } & ConnectCurrentArgs) | undefined
): { openBrowser: boolean; authorizeParams?: Record<string, string> } {
  return {
    openBrowser: setup?.openBrowser !== false,
    ...(setup?.authorizeParams ? { authorizeParams: setup.authorizeParams } : {})
  }
}
