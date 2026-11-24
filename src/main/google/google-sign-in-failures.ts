// Why a Google sign-in failed after Google returned, in the words the CLI, the card and the tab show.
import { HOST_ACCOUNT_SIGN_IN_FAILURE_COPY } from '../../shared/agent-accounts/host-account-sign-in-types'
import { GoogleTokenError } from './google-token-endpoint'

const GOOGLE_SIGN_IN_FAILURES = {
  network:
    'Orca couldn’t reach Google from this computer. Check your VPN, proxy or HTTPS inspection, then try again.',
  invalid_client:
    'Google rejected this app’s client secret. Download the client file again and import it in Orca.',
  invalid_grant: 'Google says this sign-in was already used or has expired. Start again in Orca.',
  refused: 'Google didn’t finish the sign-in. Start again in Orca.',
  no_account: 'Google didn’t say which account signed in. Try again.',
  no_refresh_token: 'Google didn’t return a lasting sign-in. Try again.',
  save_failed: 'Orca couldn’t save the Google account on this computer. Try again.',
  owner_silent: HOST_ACCOUNT_SIGN_IN_FAILURE_COPY.ownerSilent
} as const

type GoogleSignInFailureCategory = keyof typeof GOOGLE_SIGN_IN_FAILURES

/** Logs the step and category only: never a code, token, account or address. */
export function signInFailure(
  step: 'token exchange' | 'account' | 'save',
  category: GoogleSignInFailureCategory
): Error {
  console.warn(`[google] sign-in failed at ${step}: ${category}`)
  return new Error(GOOGLE_SIGN_IN_FAILURES[category])
}

export function exchangeFailureCategory(error: unknown): GoogleSignInFailureCategory {
  if (!(error instanceof GoogleTokenError)) {
    return 'network'
  }
  return error.code === 'invalid_client' || error.code === 'invalid_grant' ? error.code : 'refused'
}
