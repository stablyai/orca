import { resolve } from 'node:path'
import { getClaudeProfileRouter } from '../../claude-accounts/claude-profile-installed-router'
import { agentSessionAccountHomesEqual } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { claudeNamingContextId } from '../claude-conversation-naming'
import { CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS } from '../claude-cli-flag-support'
import type { StructuredAgentSessionAdapter } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { ClaudeSession } from './claude-structured-session-state'

export const captureClaudeConversationTitleOwner =
  (
    sessions: Map<string, ClaudeSession>
  ): NonNullable<StructuredAgentSessionAdapter['captureConversationTitleOwner']> =>
  (record) => {
    const session = sessions.get(record.sessionId)
    if (!session) {
      return null
    }
    const { connection, acquisitionGeneration, fence, providerSessionId, initialization } = session
    const boundary = record.providerContextBoundary?.operationId
    const account = () => {
      try {
        const policy = getClaudeProfileRouter()?.preparation()
        const recipe = initialization.accountRecipe
        if (policy) {
          if ((recipe?.route ?? initialization.account) === 'managed') {
            if (
              !policy.provenance.startsWith('profile:') ||
              (recipe?.route === 'managed' &&
                policy.provenance !== `profile:${recipe.accountId}`) ||
              resolve(initialization.cwd, policy.configDir) !== initialization.claudeConfigDir
            ) {
              return null
            }
          } else if (policy.provenance !== 'system') {
            return null
          }
        }
        return JSON.stringify([
          policy?.provenance,
          policy?.provenance.startsWith('profile:') ? policy.configDir : null
        ])
      } catch {
        return null
      }
    }
    const selectedAccount = account()
    const isCurrent: NonNullable<
      ReturnType<NonNullable<StructuredAgentSessionAdapter['captureConversationTitleOwner']>>
    >['isCurrent'] = (current) =>
      sessions.get(record.sessionId) === session &&
      session.connection === connection &&
      !connection.closed &&
      !session.closeFinalization &&
      session.acquisitionGeneration === acquisitionGeneration &&
      session.fence === fence &&
      current.lease.runtimeFence === fence &&
      current.provider === 'claude' &&
      session.providerSessionId === providerSessionId &&
      claudeNamingContextId(current) === providerSessionId &&
      current.providerContextBoundary?.operationId === boundary &&
      agentSessionAccountHomesEqual(current.accountHome, record.accountHome) &&
      current.location.workspaceId === record.location.workspaceId &&
      current.location.executionHostId === record.location.executionHostId &&
      session.initialization === initialization &&
      selectedAccount !== null &&
      account() === selectedAccount
    return {
      isCurrent,
      generate: async (firstPrompt, shouldExecute) => {
        if (
          !session.initialization.startup.opened() ||
          !connection.generateSessionTitle ||
          !shouldExecute()
        ) {
          return null
        }
        // Verified support floor, not the request's introduction version; never start a probe here.
        const supported = await session.cliFlag?.(
          { option: 'generate_session_title', firstVersion: '2.1.310' },
          CLAUDE_CACHED_FLAG_CHECK_BUDGET_MS,
          false
        )
        return supported === 'supported' && shouldExecute()
          ? connection.generateSessionTitle?.(firstPrompt)
          : null
      }
    }
  }
