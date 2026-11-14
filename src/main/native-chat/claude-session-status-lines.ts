import { contextTokensFromUsage } from '../../shared/agent-session/agent-session-context-usage'
import type { ClaudeSessionStatusFacts } from '../../shared/native-chat/claude-session-status'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { claudeTokenUsage } from '../claude/claude-context-usage'

const MAIN_THREAD_QUERY_SOURCE = 'repl_main_thread'
const SYNTHETIC_MODEL = '<synthetic>'

export function emptyClaudeSessionStatusFacts(): ClaudeSessionStatusFacts {
  return { model: null, effort: null, usedTokens: null, compactions: 0 }
}

// Session files reach many megabytes; only these rows are worth parsing.
function mayCarryStatus(line: string): boolean {
  return (
    line.includes('"assistant"') ||
    line.includes('"api-request"') ||
    line.includes('compact_boundary')
  )
}

/** Folds one transcript line into `facts`; rows are applied in file order, so the newest wins. */
export function applyClaudeSessionStatusLine(facts: ClaudeSessionStatusFacts, line: string): void {
  if (!mayCarryStatus(line)) {
    return
  }
  const record = parseJsonObject(line)
  if (!record || record.isSidechain === true) {
    return
  }
  if (record.type === 'assistant') {
    const message = asRecord(record.message)
    const model = extractString(message?.model)
    const usage = claudeTokenUsage(message?.usage)
    if (model && model !== SYNTHETIC_MODEL && usage) {
      facts.model = model
      facts.usedTokens = contextTokensFromUsage(usage)
    }
    return
  }
  if (record.type === 'api-request' && record.querySource === MAIN_THREAD_QUERY_SOURCE) {
    const effort = extractString(asRecord(asRecord(record.params)?.output_config)?.effort)
    if (effort) {
      facts.effort = effort
    }
    return
  }
  if (record.type === 'system' && record.subtype === 'compact_boundary') {
    facts.compactions += 1
    facts.usedTokens = null
  }
}
