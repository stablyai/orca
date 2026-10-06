// The one row a Claude `system/api_retry` frame writes: a sentence and a `providerRetrying` fact,
// revised in place for every attempt of the same retry run.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  readProviderRetry
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'

export const CLAUDE_API_RETRY_FRAME_KIND = 'message:system:api_retry'

export function claudeApiRetryRowBody(message: Record<string, unknown>): AgentJournalStatusItem {
  const retry = readProviderRetry({
    error: message.error,
    status: message.error_status,
    attempt: message.attempt,
    maxAttempts: message.max_retries
  })
  const words = agentSessionFailureWords(
    agentSessionFailureFact('providerRetrying', {
      detail: providerDiagnostic(JSON.stringify(message), 'log'),
      ...(retry ? { retry } : {})
    }),
    { surface: 'row', agentName: TUI_AGENT_DISPLAY_NAMES.claude }
  )
  return { kind: 'status', tone: 'warning', ...words }
}

/** Numbers retry runs: a frame whose attempt does not follow the last one starts a new run. */
export function createClaudeApiRetryRuns(): (message: Record<string, unknown>) => number {
  let run = 0
  let lastAttempt: number | null = null
  return (message) => {
    const attempt = typeof message.attempt === 'number' ? message.attempt : null
    if (attempt === null || lastAttempt === null || attempt <= lastAttempt) {
      run += 1
    }
    lastAttempt = attempt
    return run
  }
}
