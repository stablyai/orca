import { AntigravityChatAuthConfigError } from '../../shared/antigravity-chat-auth-config'
import { AcpAgentError } from '../acp/transport/acp-errors'
import '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { isAgentSessionPreSpawnError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { AntigravitySignInSentence } from './antigravity-chat-account'

export const SIGN_IN_FAILED = 'Google sign-in for Antigravity failed. Start sign-in again.'

export function antigravitySignInFailure(error: unknown): string {
  const cause = isAgentSessionPreSpawnError(error) ? error.cause : error
  if (
    cause instanceof AntigravitySignInSentence ||
    cause instanceof AntigravityChatAuthConfigError
  ) {
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
