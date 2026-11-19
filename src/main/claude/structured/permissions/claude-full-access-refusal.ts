// Claude starts a Full access launch in another mode when its settings turn bypass off
// (`permissions.disableBypassPermissionsMode`); only its root init says so.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'

/** A Plan start hides the refusal: Plan is what a Full access launch reports then too. */
export function claudeFullAccessRefusedAtStart(
  requested: PermissionMode | undefined,
  opened: string | null | undefined
): boolean {
  return (
    requested === 'bypassPermissions' &&
    typeof opened === 'string' &&
    opened !== 'bypassPermissions' &&
    opened !== 'plan'
  )
}

const MAX_ANNOUNCED = 1_000
const announced = new Set<string>()

/** Once per chat while Orca runs: each restart of a refused chat opens the same way. */
export function claimClaudeFullAccessRefusalNotice(sessionId: string): boolean {
  if (announced.has(sessionId)) {
    return false
  }
  announced.add(sessionId)
  if (announced.size > MAX_ANNOUNCED) {
    announced.delete(announced.values().next().value as string)
  }
  return true
}

function claudeFullAccessRefusalRow(init: Record<string, unknown>): AgentJournalStatusItem {
  const choice = readClaudeReportedPermissionMode(init)
  const running = isAgentChatPermissionMode(choice)
    ? agentChatPermissionModeCopy('claude', choice).label
    : 'its own permission settings'
  return {
    kind: 'status',
    tone: 'warning',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text: `Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so this chat runs with ${running}.`
  }
}

/** One warning row on the root init where Claude first shows the refusal. */
export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'claimFullAccessRefusal'>,
  init: Record<string, unknown>,
  idPrefix: string,
  turnScope: AgentJournalTurnScope
): void {
  if (!deps.claimFullAccessRefusal?.(init)) {
    return
  }
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `full-access-refused:claude:${idPrefix}` },
    claudeFullAccessRefusalRow(init),
    { turnScope }
  )
  deps.sink.publish()
}
