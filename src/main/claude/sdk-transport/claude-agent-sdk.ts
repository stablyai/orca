import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'

/** Lazy import confines SDK executable-search env mutation and missing-package failures to structured Claude. */

let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

export function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  claudeAgentSdk ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeAgentSdk
}
