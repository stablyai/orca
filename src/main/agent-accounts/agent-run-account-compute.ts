import type { AgentRunAccount, AgentRunAccountProvider } from '../../shared/agent-run-account'
import type { CodexPaneAccountRecord } from '../codex/codex-pane-account-registry'
import { isCodexPaneKeepable } from '../codex/codex-stale-pane-accounts'

/** The account a statusline folder belongs to; 'unknown-folder' = no account owns it. */
export type ClaudeStatusLineReport = { accountId: string | null } | 'unknown-folder'

/** What this runtime knows about the Claude session in one pane. */
export type ClaudePaneObservation = {
  /** Account the session runs on; undefined = this runtime never saw it start. */
  accountId: string | null | undefined
  /** Latest statusline report since the session started. */
  statusLine?: ClaudeStatusLineReport
  shellRoute: 'selected' | 'account'
}

export type AgentRunAccountInput = {
  agentType: string | undefined
  connectionId: string | null
  structured: boolean
  providerSessionId: string | null
  /** The provider has at least one saved account, so naming an account means something. */
  hasManagedAccounts: boolean
  /** Lane the pane launched from, when this runtime knows it. */
  lane: string | undefined
  codexRecord: CodexPaneAccountRecord | null
  claude: ClaudePaneObservation | null
  /** The row's current facet, carried from an earlier runtime when nothing newer is known. */
  current: AgentRunAccount | undefined
  /** Account a person kept this Claude conversation on; undefined = not kept. */
  claudeKeptAccountId: string | null | undefined
}

export function runAccountProvider(agentType: string | undefined): AgentRunAccountProvider | null {
  return agentType === 'claude' || agentType === 'codex' ? agentType : null
}

/** The facet a local terminal agent's row should carry; null = none. Never guesses. */
export function computeAgentRunAccount(input: AgentRunAccountInput): AgentRunAccount | null {
  const provider = runAccountProvider(input.agentType)
  if (
    !provider ||
    input.connectionId !== null ||
    input.structured ||
    !input.hasManagedAccounts ||
    (input.lane !== undefined && input.lane !== 'host')
  ) {
    return null
  }
  return provider === 'codex' ? computeCodex(input) : computeClaude(input)
}

function computeCodex(input: AgentRunAccountInput): AgentRunAccount | null {
  const record = input.codexRecord
  if (!record) {
    // Why: until this runtime can read the pane's launch record, the persisted facet stands.
    return input.current?.provider === 'codex' ? input.current : null
  }
  if (record.selectionKey !== 'host') {
    return null
  }
  return {
    provider: 'codex',
    lane: 'host',
    accountId: record.accountId,
    mode: record.kept ? 'kept' : 'follow',
    ...(isCodexPaneKeepable(record) ? {} : { keepUnavailable: 'codex-home-not-keepable' })
  }
}

/** What the facet an earlier runtime left on the row says about its Claude session. */
function persistedObservation(current: AgentRunAccount | undefined): ClaudePaneObservation | null {
  return current?.provider === 'claude'
    ? { accountId: current.accountId, shellRoute: current.shellRoute ?? 'selected' }
    : null
}

function computeClaude(input: AgentRunAccountInput): AgentRunAccount | null {
  // Why: a pane this runtime has not seen report, such as an idle terminal that outlived a restart,
  // keeps the account an earlier runtime recorded for it. Only the keep is read afresh, so one
  // made or released since still shows.
  const observed = input.claude ?? persistedObservation(input.current)
  if (!observed) {
    return null
  }
  if (observed.statusLine === 'unknown-folder') {
    return null
  }
  const accountId = observed.statusLine ? observed.statusLine.accountId : observed.accountId
  if (accountId === undefined) {
    return null
  }
  const keptOn = input.providerSessionId !== null ? input.claudeKeptAccountId : undefined
  const kept = keptOn !== undefined && keptOn === accountId
  return {
    provider: 'claude',
    lane: 'host',
    accountId,
    mode: kept ? 'kept' : 'follow',
    shellRoute: observed.shellRoute,
    ...(input.providerSessionId === null ? { keepUnavailable: 'no-session' } : {}),
    // Why: a person's own keep stays on its account when the agent ends up on another, and a
    // restart resumes the conversation there, wherever the selection points.
    ...(keptOn !== undefined && !kept ? { keptElsewhere: true as const } : {})
  }
}
