import { AcpAgentError } from '../acp/acp-errors'
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AntigravitySignInSentence } from './antigravity-chat-account'

export const SIGN_IN_FAILED = 'Google sign-in for Antigravity failed. Start sign-in again.'

export function antigravitySignInFailure(error: unknown): string {
  const cause = isAgentSessionPreSpawnError(error) ? error.cause : error
  if (cause instanceof AntigravitySignInSentence) {
    return cause.message
  }
  if (isAgentSessionPreSpawnError(error) && error.reason === 'runtimeNotInstalled') {
    return 'Antigravity is not installed on this host. Install it, then start sign-in again.'
  }
  if (error instanceof AcpAgentError) {
    // Provider errors may put the reason in data instead of message.
    const text = `${error.message} ${JSON.stringify(error.data ?? '')}`
    if (text.includes('SUBSCRIPTION_REQUIRED')) {
      return 'Google requires an eligible Antigravity subscription for this account.'
    }
    if (/onboarding failed|ineligible/i.test(text)) {
      return "This Google account can't use Antigravity. Sign in with a different account."
    }
    if (/access_denied|denied access|cancelled/i.test(text)) {
      return 'Google sign-in for Antigravity was not approved. Start sign-in again.'
    }
  }
  return SIGN_IN_FAILED
}

export function antigravitySignInSessionFailure(error: unknown): never {
  const plain = error instanceof AcpAgentError && error.code === -32603
  throw plain && antigravitySignInFailure(error) === SIGN_IN_FAILED
    ? new AntigravitySignInSentence(
        'Antigravity authenticated, but could not initialize a session or load models.'
      )
    : error
}

export const SECOND_LINK = {
  phase: 'failed',
  error: 'Antigravity started more than one Google sign-in request.'
} as const
