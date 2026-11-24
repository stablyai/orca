// What comes back from Google's page: the address the browser returns to, the checks it must pass
// before a sign-in takes it, and the page its tab shows. Nothing here fetches a returned address.
import { HOST_ACCOUNT_SIGN_IN_FAILURE_COPY } from '../../shared/agent-accounts/host-account-sign-in-types'
import type { GoogleSignInPrompt } from '../../shared/google/google-connect-types'
import type { LoopbackCallbackHold } from '../orca-profiles/cloud-auth/loopback-callback'
import {
  orcaCallbackOutcome,
  orcaCallbackReceivedPage
} from '../orca-profiles/cloud-auth/profile-cloud-callback-page'

export const GOOGLE_CALLBACK_PATH = '/google/callback'

export function googleRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`
}

/** How the tab Google returned to ends, once the host has the account saved (or failed). */
export const GOOGLE_RETURN_PAGES = {
  signedIn: orcaCallbackOutcome({
    ok: true,
    heading: 'Signed in to Google',
    line: 'You can close this tab and return to Orca.'
  }),
  /** Says why, in the same words Orca and the CLI show. */
  notSignedIn: (reason: string) =>
    orcaCallbackOutcome({ ok: false, heading: 'Couldn’t sign in to Google', line: reason }),
  cancelled: orcaCallbackOutcome({
    ok: null,
    heading: 'Google sign-in was cancelled',
    line: 'Orca stopped waiting for this sign-in. Return to Orca to sign in again.'
  })
} as const
/** A tab whose sign-in ended without an account says what Orca and the CLI say: a silent stop wins over the step that failed. */
export function googleFailedReturnPage(
  stopped: 'cancelled' | 'silent' | null,
  error: unknown
): string {
  if (stopped === 'cancelled') {
    return GOOGLE_RETURN_PAGES.cancelled
  }
  return GOOGLE_RETURN_PAGES.notSignedIn(
    stopped === 'silent'
      ? HOST_ACCOUNT_SIGN_IN_FAILURE_COPY.ownerSilent
      : error instanceof Error
        ? error.message
        : 'Return to Orca and try again.'
  )
}

export const GOOGLE_RETURN_HOLD: LoopbackCallbackHold = {
  received: orcaCallbackReceivedPage(),
  pending: orcaCallbackOutcome({
    ok: null,
    heading: 'Finishing sign-in…',
    line: 'Return to Orca to finish.'
  }),
  ms: 15_000
}

/** What a returned address must match; checked before a pasted one is taken. */
export type GoogleSignInExpectation = { state: string; redirectUri: string; expiresAt: number }

/** A prompt carries its own sign-in's expectation: the state is the one in its link. */
export function googlePromptExpectation(prompt: GoogleSignInPrompt): GoogleSignInExpectation {
  return {
    state: new URL(prompt.authorizeUrl).searchParams.get('state') ?? '',
    redirectUri: prompt.redirectUri,
    expiresAt: prompt.expiresAt
  }
}

const NOT_THIS_SIGN_IN =
  "That address isn't from the Google sign-in Orca just started on this computer. Start again in Orca."

const GOOGLE_REFUSALS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled, or access was not allowed.',
  admin_policy_enforced: "Your company's Google admin blocked this app. Ask them to allow it.",
  org_internal:
    'This Google app is limited to its own company. Sign in with an account from that company.'
}

/**
 * The query of an address Google sent the browser back to, once it is proven to be this sign-in's:
 * the only part of a returned address the sign-in keeps. Nothing here fetches the address.
 */
export function googleCallbackQuery(
  callbackUrl: string,
  expected: GoogleSignInExpectation
): string {
  let url: URL
  try {
    url = new URL(callbackUrl.trim())
  } catch {
    throw new Error(`${NOT_THIS_SIGN_IN} Paste the whole address from the browser.`)
  }
  readGoogleCallback(url, expected)
  return url.search
}

/** The code in an address Google sent the browser back to, once it is proven to be this sign-in's. */
export function readGoogleCallback(url: URL, expected: GoogleSignInExpectation): string {
  const redirect = new URL(expected.redirectUri)
  if (
    url.protocol !== 'http:' ||
    url.host !== redirect.host ||
    url.pathname !== redirect.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    !singleParams(url.searchParams) ||
    url.searchParams.get('state') !== expected.state
  ) {
    throw new Error(NOT_THIS_SIGN_IN)
  }
  const refused = url.searchParams.get('error')
  if (refused) {
    throw new Error(
      GOOGLE_REFUSALS[refused] ?? `Google refused the sign-in (${refused.slice(0, 64)}).`
    )
  }
  const code = url.searchParams.get('code')
  if (!code) {
    throw new Error(NOT_THIS_SIGN_IN)
  }
  return code
}

const singleParams = (params: URLSearchParams): boolean =>
  new Set(params.keys()).size === [...params.keys()].length

/**
 * Whether a hit to the callback path is shaped as this sign-in's return: its state, no field twice,
 * and a code or Google's error. Anything else is stray, so it never spends the sign-in.
 */
export function isGoogleReturnFor(url: URL, state: string): boolean {
  const params = url.searchParams
  return (
    singleParams(params) &&
    params.get('state') === state &&
    Boolean(params.get('code') || params.get('error'))
  )
}
