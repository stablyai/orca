import { AntigravityChatAuthConfigError } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import {
  ANTIGRAVITY_ACCOUNT_INELIGIBLE,
  ANTIGRAVITY_SUBSCRIPTION_REQUIRED
} from '../../shared/agent-accounts/antigravity/antigravity-sign-in-sentences'
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
    if (/GEMINI_API_KEY environment variable is not set/i.test(text)) {
      return 'Antigravity found no GEMINI_API_KEY. Set it in your shell or in Antigravity’s environment variables in Orca, then try again.'
    }
    if (text.includes('SUBSCRIPTION_REQUIRED')) {
      return ANTIGRAVITY_SUBSCRIPTION_REQUIRED
    }
    if (/onboarding failed|ineligible/i.test(text)) {
      return ANTIGRAVITY_ACCOUNT_INELIGIBLE
    }
    if (/access_denied|denied access|cancelled/i.test(text)) {
      return 'Google sign-in for Antigravity was not approved. Start sign-in again.'
    }
  }
  return SIGN_IN_FAILED
}
