import type { AgentTokenCounts } from '../../shared/telemetry-agent-token-usage-schema'
import type { ClaudeUsageSession } from '../claude-usage/types'
import type { CodexUsageSession } from '../codex-usage/types'
import type { OpenCodeUsageSession } from '../opencode-usage/types'

export type AgentTokenSession = AgentTokenCounts & { providerSessionId: string }

export function claudeTokenSessions(sessions: ClaudeUsageSession[]): AgentTokenSession[] {
  return sessions.flatMap((session) => {
    const locations = session.locationBreakdown.filter((entry) => entry.worktreeId !== null)
    if (locations.length === 0) {
      return []
    }
    return [
      {
        providerSessionId: session.sessionId,
        input_tokens: locations.reduce((sum, entry) => sum + entry.inputTokens, 0),
        output_tokens: locations.reduce((sum, entry) => sum + entry.outputTokens, 0),
        cached_input_tokens: locations.reduce((sum, entry) => sum + entry.cacheReadTokens, 0),
        cache_write_input_tokens: locations.reduce((sum, entry) => sum + entry.cacheWriteTokens, 0)
      }
    ]
  })
}

export function codexOpenCodeTokenSessions(
  sessions: (CodexUsageSession | OpenCodeUsageSession)[]
): AgentTokenSession[] {
  return sessions.flatMap((session) => {
    const locations = session.locationBreakdown.filter((entry) => entry.worktreeId !== null)
    if (locations.length === 0) {
      return []
    }
    return [
      {
        providerSessionId: session.sessionId,
        // Codex/OpenCode include cache hits in input; Claude records them separately.
        input_tokens: locations.reduce(
          (sum, entry) => sum + entry.inputTokens - entry.cachedInputTokens,
          0
        ),
        output_tokens: locations.reduce((sum, entry) => sum + entry.outputTokens, 0),
        cached_input_tokens: locations.reduce((sum, entry) => sum + entry.cachedInputTokens, 0),
        cache_write_input_tokens: 0
      }
    ]
  })
}
