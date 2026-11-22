import { AcpAgentError } from '../transport/acp-errors'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import { acpAuthenticationRequired } from '../turns/acp-prompt-failure'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'

// A listing often reaches a signed-out server before any chat sends; telling the spec lets a chat
// offer its sign-in choices without a failed send first.
export const signedOutAsUnavailable =
  (dialect: AcpDialect, answerSignIn?: (signedIn: boolean) => void) => (error: unknown) => {
    if (
      !(
        error instanceof AcpAgentError &&
        (error.code === -32000 || acpAuthenticationRequired(dialect, error))
      )
    ) {
      throw error
    }
    answerSignIn?.(false)
    throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
  }
