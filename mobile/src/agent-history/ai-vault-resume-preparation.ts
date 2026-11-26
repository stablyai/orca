import {
  aiVaultAgentLabel,
  type AiVaultSession
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultSessionAfterResumePreparation,
  aiVaultSessionNeedsResumePreparation,
  aiVaultTerminalResumeRequest,
  isAiVaultPrepareSessionResumeUnavailableError
} from '../../../src/shared/ai-vault/resume/ai-vault-resume-preparation'
import { aiVaultResumePreparationRun } from './mobile-ai-vault-resume-operations'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import { translate } from '../i18n/mobile-i18n'

// Why: without an explicit timeout, a socket drop mid-resume parks the request
// on the reconnect waiter for the full reconnect budget, pinning the spinner.
export const RESUME_RPC_TIMEOUT_MS = 30_000

/** Every terminal resume asks the host first, as desktop does: it refuses a conversation a chat now holds. */
export async function prepareMobileAiVaultSessionResume(
  client: UnvalidatedRpcRequestPort,
  session: AiVaultSession
): Promise<AiVaultSession> {
  const response = await aiVaultResumePreparationRun.request(
    client,
    aiVaultTerminalResumeRequest({
      agent: session.agent,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      filePath: session.filePath,
      codexHome: session.codexHome,
      executionHostId: session.executionHostId
    }),
    { timeoutMs: RESUME_RPC_TIMEOUT_MS }
  )
  if (!response.ok) {
    if (isAiVaultPrepareSessionResumeUnavailableError(response.error)) {
      // Why: older hosts cannot prepare, but their shared home still supports the legacy resume path.
      return session
    }
    throw new Error(
      response.error?.message ||
        translate(
          'session.aiVaultResumePreparation.prepareFailed',
          'Could not prepare this legacy Codex session. Retry resume.'
        )
    )
  }
  // Why: old resumes kept the recorded home for sessions that need no readying.
  if (!aiVaultSessionNeedsResumePreparation(session)) {
    return session
  }
  const result = aiVaultResumePreparationRun.interpret(response)
  return aiVaultSessionAfterResumePreparation(session, {
    useRealCodexHome: result?.useRealCodexHome === true,
    substituteCodexHome: result?.substituteCodexHome
  })
}

/** Desktop's wording for the host's resume refusals, which arrive as bare codes from prepare, create or send. */
export function aiVaultResumeRefusalText(
  message: string,
  agent: AiVaultSession['agent']
): string | null {
  const options = { agent: aiVaultAgentLabel(agent) }
  switch (message) {
    case 'agent_session_conflict':
      return translate(
        'session.aiVaultResumePreparation.openInChat',
        'This {{agent}} conversation is open in a chat. Refresh Session History to open it.',
        options
      )
    case 'agent_session_ownership_unknown':
      return translate(
        'session.aiVaultResumePreparation.ownershipUnknown',
        'Orca could not confirm who owns this {{agent}} conversation. Refresh Session History and try again.',
        options
      )
    case 'execution_owner_reconciling':
      return translate(
        'session.aiVaultResumePreparation.preparationRefused',
        'Orca could not prepare this {{agent}} conversation. Start a new chat to continue.',
        options
      )
    default:
      return null
  }
}
