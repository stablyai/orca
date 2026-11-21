import { createHash, randomBytes } from 'node:crypto'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { serveHeldLoopbackCallback } from './loopback-callback'
import {
  orcaCallbackReceivedPage,
  orcaCloudCallbackOutcome,
  type OrcaCloudCallbackOutcome
} from './profile-cloud-callback-page'

export type OrcaCloudAuthorizationCode = {
  code: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  state: string
}

export type OrcaCloudBrowserReturn = OrcaCloudAuthorizationCode & {
  /** Ends the browser tab with the real outcome; only the first answer counts. */
  respond: (outcome: OrcaCloudCallbackOutcome) => void
}

const AUTH_TIMEOUT_MS = 5 * 60 * 1000
const BROWSER_RESPONSE_TIMEOUT_MS = 45 * 1000

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function createCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

/** The secret half (verifier) stays with the host that redeems the code; the rest goes into the link. */
export function createOrcaCloudPkceSecrets(): {
  codeVerifier: string
  codeChallenge: string
  nonce: string
  state: string
} {
  const codeVerifier = createCodeVerifier()
  return {
    codeVerifier,
    codeChallenge: createCodeChallenge(codeVerifier),
    nonce: base64Url(randomBytes(32)),
    state: base64Url(randomBytes(32))
  }
}

export function beginOrcaCloudPkceFlow(
  config: OrcaCloudAuthConfig,
  localProfileId: string,
  options: {
    openBrowser: (url: string) => Promise<void>
    onAuthorizeUrl?: (url: string) => void
    signal?: AbortSignal
  }
): Promise<OrcaCloudBrowserReturn> {
  const { codeVerifier, codeChallenge, nonce, state } = createOrcaCloudPkceSecrets()
  let redirectUri = ''

  const returned = serveHeldLoopbackCallback<OrcaCloudAuthorizationCode>({
    path: '/auth/callback',
    timeoutMs: AUTH_TIMEOUT_MS,
    signal: options.signal,
    // The tab waits for the code exchange so it never claims a sign-in the app did not finish.
    hold: {
      received: orcaCallbackReceivedPage(),
      pending: orcaCloudCallbackOutcome({
        status: 'failed',
        error: 'orca_cloud_auth_response_timeout'
      }),
      ms: BROWSER_RESPONSE_TIMEOUT_MS
    },
    errors: {
      timeout: 'orca_cloud_auth_timeout',
      cancelled: 'orca_cloud_auth_cancelled',
      unavailable: 'orca_cloud_auth_loopback_unavailable',
      failed: 'orca_cloud_auth_callback_failed'
    },
    read: (url) => {
      const invalid = { kind: 'stray', message: 'Invalid Orca sign-in response.' } as const
      // Stray loopback probes must not cancel the user’s login.
      if (url.searchParams.get('state') !== state) {
        return invalid
      }
      if (url.searchParams.has('error')) {
        const cancelled = url.searchParams.get('error') === 'access_denied'
        return {
          kind: 'reject',
          message: cancelled
            ? 'Orca sign-in was cancelled.'
            : 'Orca sign-in failed. Return to Orca and try again.',
          error: new Error(cancelled ? 'orca_cloud_auth_denied' : 'orca_cloud_auth_callback_failed')
        }
      }
      const code = url.searchParams.get('code')
      return code
        ? { kind: 'accept', value: { code, codeVerifier, nonce, redirectUri, state } }
        : invalid
    },
    onListening: async (port) => {
      redirectUri = `http://127.0.0.1:${port}/auth/callback`
      const authorizeUrl = new URL(config.authorizeEndpoint)
      authorizeUrl.searchParams.set('client_id', config.clientId)
      authorizeUrl.searchParams.set('response_type', 'code')
      authorizeUrl.searchParams.set('redirect_uri', redirectUri)
      authorizeUrl.searchParams.set('scope', config.scope)
      authorizeUrl.searchParams.set('nonce', nonce)
      authorizeUrl.searchParams.set('state', state)
      authorizeUrl.searchParams.set('code_challenge', codeChallenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      authorizeUrl.searchParams.set('local_profile_id', localProfileId)
      options.onAuthorizeUrl?.(authorizeUrl.toString())
      try {
        await options.openBrowser(authorizeUrl.toString())
      } catch (error) {
        throw error instanceof Error ? error : new Error('orca_cloud_auth_browser_open_failed')
      }
    }
  })
  return returned.then(({ value, answer }) => ({
    ...value,
    respond: (outcome) => answer(orcaCloudCallbackOutcome(outcome))
  }))
}
