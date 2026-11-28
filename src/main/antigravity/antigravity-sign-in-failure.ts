import {
  ANTIGRAVITY_ACCOUNT_INELIGIBLE,
  ANTIGRAVITY_SUBSCRIPTION_REQUIRED
} from '../../shared/agent-accounts/antigravity/antigravity-sign-in-sentences'

export const SIGN_IN_FAILED = 'Google sign-in for Antigravity failed. Start sign-in again.'

/** What a failed `agy acp --login` says, from its output. */
export function agyLoginFailure(output: string): string {
  if (output.includes('SUBSCRIPTION_REQUIRED')) {
    return ANTIGRAVITY_SUBSCRIPTION_REQUIRED
  }
  if (/onboarding failed|ineligible/i.test(output)) {
    return ANTIGRAVITY_ACCOUNT_INELIGIBLE
  }
  // agy 1.5.16: `couldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."`
  if (/invalid_grant/i.test(output)) {
    return "Google didn't accept that code. Sign in again to get a new one."
  }
  if (/access_denied|denied access|cancelled/i.test(output)) {
    return 'Google sign-in for Antigravity was not approved. Start sign-in again.'
  }
  return SIGN_IN_FAILED
}
