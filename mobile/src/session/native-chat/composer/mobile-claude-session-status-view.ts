import type { ClaudeSessionStatus } from '../../../../../src/shared/native-chat/claude-session-status'
import { formatContextTokenCount } from '../../../../../src/shared/native-chat/native-chat-context-usage-summary'

const CONTEXT_CRITICAL_PERCENT = 80
const CONTEXT_WARNING_TOKENS = 300_000
const COMPACTIONS_WARNING = 4
const COMPACTIONS_CRITICAL = 6

export type ClaudeSessionStatusTone = 'ok' | 'warn' | 'crit'

export type ClaudeSessionStatusView = {
  /** Null right after a compaction, until the next reply measures the context. */
  context: {
    /** Null with the window: a percent of an unknown window would be invented. */
    percent: number | null
    used: string
    window: string | null
    tone: ClaudeSessionStatusTone
  } | null
  compactions: number
  compactionTone: 'neutral' | 'warn' | 'crit'
}

function contextTone(usedTokens: number, percent: number | null): ClaudeSessionStatusTone {
  if (percent !== null && percent >= CONTEXT_CRITICAL_PERCENT) {
    return 'crit'
  }
  return usedTokens >= CONTEXT_WARNING_TOKENS ? 'warn' : 'ok'
}

function compactionTone(compactions: number): ClaudeSessionStatusView['compactionTone'] {
  if (compactions >= COMPACTIONS_CRITICAL) {
    return 'crit'
  }
  return compactions >= COMPACTIONS_WARNING ? 'warn' : 'neutral'
}

/** Null when the session has reported nothing, so the composer keeps its usual height. */
export function viewClaudeSessionStatus(
  status: ClaudeSessionStatus
): ClaudeSessionStatusView | null {
  const { usedTokens, windowTokens, compactions, model } = status
  if (usedTokens === null && compactions === 0 && model === null) {
    return null
  }
  const percent =
    usedTokens !== null && windowTokens !== null
      ? Math.round((usedTokens / windowTokens) * 100)
      : null
  return {
    context:
      usedTokens === null
        ? null
        : {
            percent,
            used: formatContextTokenCount(usedTokens),
            window: windowTokens === null ? null : formatContextTokenCount(windowTokens),
            tone: contextTone(usedTokens, percent)
          },
    compactions,
    compactionTone: compactionTone(compactions)
  }
}
