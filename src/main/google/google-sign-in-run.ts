// One Google sign-in, run on the host that will keep the grant: PKCE S256 and `state` are made and
// checked here, and the code is exchanged here. The browser comes back to a loopback port on this
// host, to one the calling client owns (a paired desktop), or as an address pasted back.
import {
  GOOGLE_SIGN_IN_EXPIRED,
  type GoogleSignInPrompt
} from '../../shared/google/google-connect-types'
import {
  googleChoices,
  googleSignInScopes,
  grantedGoogleChoices,
  type GoogleServiceChoice
} from '../../shared/google/google-scopes'
import type { GoogleClientConfig } from '../../shared/google/google-client-config'
import type { CallerOwnedSignInChannel } from '../runtime/caller-owned-sign-in-flows'
import {
  serveHeldLoopbackCallback,
  type HeldLoopbackReturn
} from '../orca-profiles/cloud-auth/loopback-callback'
import { createOrcaCloudPkceSecrets } from '../orca-profiles/cloud-auth/profile-cloud-pkce'
import { checkGoogleClientKey } from './google-client-check'
import { checkGoogleServices } from './google-readiness'
import {
  readGoogleAccount,
  saveGoogleAccount,
  type GoogleAccountRecord
} from './google-credential-store'
import {
  accountFromIdToken,
  exchangeGoogleCode,
  GOOGLE_AUTHORIZE_URL,
  type GoogleHttp
} from './google-token-endpoint'
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_RETURN_HOLD,
  GOOGLE_RETURN_PAGES,
  googleRedirectUri,
  isGoogleReturnFor,
  readGoogleCallback,
  type GoogleSignInExpectation
} from './google-sign-in-return'

/** A link nobody finishes stops being accepted, pasted or not, after this. */
export const GOOGLE_SIGN_IN_TTL_MS = 5 * 60_000

export const NO_GOOGLE_CLIENT =
  'Add your team’s Google client first, in Orca, from its Desktop app client file.'

export type GoogleSignInDeps = {
  http: GoogleHttp
  now: () => number
  client: () => GoogleClientConfig | null | Promise<GoogleClientConfig | null>
  /** Absent on a host with no browser of its own (orca serve). */
  openBrowser?: (url: string) => Promise<void>
}

export type GoogleSignInOptions = {
  /** A loopback port on the calling client; its browser returns there and the client relays the address. */
  callerLoopbackPort?: number
  /** Pre-selects the account, e.g. for Reconnect; a saved one signs in through its own app. */
  loginHint?: string
  /** The services asked for; the base set (who signed in, name lookup) always comes too. */
  choices: readonly GoogleServiceChoice[]
  /** The person is at this host, so its browser opens. */
  openBrowser: boolean
  /** Signs a saved account in through this computer's app too, as a setup that just made it does. */
  currentApp?: boolean
}

/** The app a sign-in goes through: its id and secret, and the Cloud project its APIs are checked in. */
type GoogleSignInClient = Pick<GoogleClientConfig, 'clientId' | 'clientSecret' | 'projectId'>

/**
 * A saved account signs in again through the app it signed in with, which may not be this
 * computer's app now (Google can refuse the account there); a new account uses this computer's.
 */
async function signInClient(
  deps: GoogleSignInDeps,
  options: GoogleSignInOptions,
  signal: AbortSignal
): Promise<GoogleSignInClient | null> {
  const saved =
    options.loginHint && !options.currentApp ? await readGoogleAccount(options.loginHint) : null
  const current = await deps.client()
  if (!saved || saved.client.clientId === current?.clientId) {
    return current
  }
  // An app Google no longer knows can't sign the account in again.
  if (current && (await checkGoogleClientKey(deps.http, saved.client, signal)) === 'gone') {
    return current
  }
  return { ...saved.client, ...(saved.projectId ? { projectId: saved.projectId } : {}) }
}

function authorizeUrl(
  client: GoogleSignInClient,
  args: {
    redirectUri: string
    state: string
    codeChallenge: string
    choices: readonly GoogleServiceChoice[]
    loginHint?: string
  }
): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL)
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', googleSignInScopes(args.choices).join(' '))
  // Keeps what the account already allowed, so adding a service asks for the union.
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', args.state)
  url.searchParams.set('code_challenge', args.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // A refresh token every time, so Reconnect always yields one; the chooser lets them add another account.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'select_account consent')
  if (args.loginHint) {
    url.searchParams.set('login_hint', args.loginHint)
  }
  return url.toString()
}

/**
 * Runs one sign-in to the end and saves the account. A returned address comes back as its query,
 * already checked against this sign-in's prompt (the flow's `readCode`), and is checked again here.
 */
export async function runGoogleSignIn(
  deps: GoogleSignInDeps,
  options: GoogleSignInOptions,
  channel: CallerOwnedSignInChannel<GoogleSignInPrompt, string>
): Promise<GoogleAccountRecord> {
  const client = await signInClient(deps, options, channel.signal)
  if (!client) {
    throw new Error(NO_GOOGLE_CLIENT)
  }
  channel.signal.throwIfAborted()
  const { codeVerifier, codeChallenge, state } = createOrcaCloudPkceSecrets()
  const expiresAt = deps.now() + GOOGLE_SIGN_IN_TTL_MS
  const expected: { current: GoogleSignInExpectation | null } = { current: null }

  const prompt = async (redirectUri: string): Promise<void> => {
    // A sign-in cancelled while its app was being chosen opens nothing.
    if (channel.signal.aborted) {
      return
    }
    expected.current = { state, redirectUri, expiresAt }
    const url = authorizeUrl(client, {
      redirectUri,
      state,
      codeChallenge,
      choices: options.choices,
      ...(options.loginHint ? { loginHint: options.loginHint } : {})
    })
    const opener = options.openBrowser ? deps.openBrowser : undefined
    const browserOpened = opener
      ? await opener(url).then(
          () => true,
          () => false
        )
      : false
    channel.onPrompt({ authorizeUrl: url, redirectUri, expiresAt, browserOpened })
  }

  const listener = new AbortController()
  const stop = (): void => listener.abort()
  channel.signal.addEventListener('abort', stop, { once: true })
  const tab: { held: HeldLoopbackReturn<string> | null } = { held: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  let query: string
  try {
    const pasted = channel.nextCode()
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(GOOGLE_SIGN_IN_EXPIRED)), GOOGLE_SIGN_IN_TTL_MS)
    })
    expired.catch(() => {})
    if (options.callerLoopbackPort !== undefined) {
      await prompt(googleRedirectUri(options.callerLoopbackPort))
      query = await Promise.race([pasted, expired])
    } else {
      const returned = serveHeldLoopbackCallback<string>({
        path: GOOGLE_CALLBACK_PATH,
        timeoutMs: GOOGLE_SIGN_IN_TTL_MS,
        signal: listener.signal,
        hold: GOOGLE_RETURN_HOLD,
        errors: {
          timeout: GOOGLE_SIGN_IN_EXPIRED,
          cancelled: 'The Google sign-in was cancelled.',
          unavailable: "Orca couldn't open a local port for Google to return to.",
          failed: 'The Google sign-in failed. Start again in Orca.'
        },
        // Probes and stale tabs leave the sign-in waiting; only this state's return counts.
        read: (url) => {
          const current = expected.current
          if (!current || !isGoogleReturnFor(url, state)) {
            return {
              kind: 'stray',
              message: 'This sign-in isn’t for this Orca. Return to Orca and try again.'
            }
          }
          try {
            readGoogleCallback(new URL(`${current.redirectUri}${url.search}`), current)
          } catch (error) {
            const refusal = error instanceof Error ? error : new Error(String(error))
            return { kind: 'reject', error: refusal, message: refusal.message }
          }
          return { kind: 'accept', value: url.search }
        },
        onListening: (port) => prompt(googleRedirectUri(port))
      }).then((held) => {
        tab.held = held
        return held.value
      })
      query = await Promise.race([returned, pasted, expired])
    }
  } finally {
    clearTimeout(timer)
    // A tab that came back stays open until the sign-in below has an outcome to show.
    if (!tab.held) {
      listener.abort()
    }
    channel.signal.removeEventListener('abort', stop)
  }
  const expectation = expected.current
  try {
    if (!expectation) {
      throw new Error('The Google sign-in did not start.')
    }
    const code = readGoogleCallback(new URL(`${expectation.redirectUri}${query}`), expectation)
    const record = await finishGoogleSignIn(deps, client, options.choices, {
      code,
      codeVerifier,
      redirectUri: expectation.redirectUri,
      signal: channel.signal
    })
    tab.held?.answer(GOOGLE_RETURN_PAGES.signedIn)
    return record
  } catch (error) {
    tab.held?.answer(GOOGLE_RETURN_PAGES.notSignedIn)
    throw error
  }
}

async function finishGoogleSignIn(
  deps: GoogleSignInDeps,
  client: GoogleSignInClient,
  asked: readonly GoogleServiceChoice[],
  args: { code: string; codeVerifier: string; redirectUri: string; signal: AbortSignal }
): Promise<GoogleAccountRecord> {
  const tokens = await exchangeGoogleCode(deps.http, client, args, args.signal)
  const account = accountFromIdToken(tokens.idToken)
  if (!account) {
    throw new Error("Google didn't say which account signed in. Try again.")
  }
  if (!tokens.refreshToken) {
    throw new Error("Google didn't return a lasting sign-in. Try again.")
  }
  const grantedScopes = tokens.scope?.split(' ') ?? []
  const now = deps.now()
  // A reconnect keeps what was picked before, whichever account the browser signed in to.
  const choices = googleChoices([
    ...asked,
    ...((await readGoogleAccount(account.email))?.choices ?? []),
    ...grantedGoogleChoices(grantedScopes)
  ])
  const services = await checkGoogleServices({
    http: deps.http,
    accessToken: tokens.accessToken,
    grantedScopes,
    choices,
    ...(client.projectId ? { projectId: client.projectId } : {})
  })
  const record: GoogleAccountRecord = {
    email: account.email,
    sub: account.sub,
    client: { clientId: client.clientId, clientSecret: client.clientSecret },
    ...(client.projectId ? { projectId: client.projectId } : {}),
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: now + tokens.expiresIn * 1000,
    grantedScopes,
    choices,
    status: 'connected',
    services,
    checkedAt: now,
    connectedAt: now
  }
  await saveGoogleAccount(record)
  return record
}
