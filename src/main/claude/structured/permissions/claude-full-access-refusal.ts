// Claude runs a Full access launch in another mode when its settings turn bypass off
// (`permissions.disableBypassPermissionsMode`), and refuses any later switch to bypass.

import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'

type ClaudeBypassFacts = Partial<
  Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'bypassDisabled'>
>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Claude's merged settings, policy tiers included, as its `get_settings` reports them. */
export function readClaudeSettingsBypassDisabled(settings: unknown): boolean | undefined {
  const effective = record(record(settings)?.effective)
  return effective
    ? record(effective.permissions)?.disableBypassPermissionsMode === 'disable'
    : undefined
}

/** A first init in Plan proves nothing: a Plan start reports Plan whatever the settings say. */
export function claudeBypassRefused(session: ClaudeBypassFacts): boolean {
  if (session.launchIntent?.permissionMode !== 'bypassPermissions') {
    return false
  }
  const opened = session.firstRootInit?.permissionMode
  return (
    session.bypassDisabled ??
    (typeof opened === 'string' && opened !== 'bypassPermissions' && opened !== 'plan')
  )
}

/** Where Claude refuses bypass, the mode it opened in, else its own fallback. */
export function claudeAllowedPermissionMode(
  session: ClaudeBypassFacts,
  mode: PermissionMode
): PermissionMode {
  if (mode !== 'bypassPermissions' || !claudeBypassRefused(session)) {
    return mode
  }
  const opened = session.firstRootInit?.permissionMode
  return opened === 'default' ||
    opened === 'acceptEdits' ||
    opened === 'auto' ||
    opened === 'dontAsk'
    ? opened
    : 'default'
}

// Claude's answer to `set_permission_mode bypassPermissions` once its settings turn bypass off.
const CLAUDE_BYPASS_REFUSAL = /bypassPermissions because it is disabled by settings/

function isClaudeBypassRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const cause = record(error.cause)
  return cause?.errorCode === 'bypass_disabled' || CLAUDE_BYPASS_REFUSAL.test(error.message)
}

/** Asks for the mode Claude allows and resolves to the mode applied. While no settings read
 *  or start proved whether Claude allows bypass, its fallback is written first and bypass right behind it:
 *  a refusal then leaves Claude in the fallback, with no late write to race a newer choice. */
export async function setClaudeAllowedPermissionMode(
  session: ClaudeBypassFacts & {
    connection: Pick<ClaudeSession['connection'], 'setPermissionMode'>
  },
  mode: PermissionMode,
  options?: { timeoutMs?: number }
): Promise<PermissionMode> {
  const allowed = claudeAllowedPermissionMode(session, mode)
  const known =
    session.bypassDisabled !== undefined ||
    session.firstRootInit?.permissionMode === 'bypassPermissions'
  if (allowed !== 'bypassPermissions' || known) {
    await session.connection.setPermissionMode(allowed, options)
    return allowed
  }
  const fallback = claudeAllowedPermissionMode({ ...session, bypassDisabled: true }, mode)
  const [fallbackWrite, bypassWrite] = await Promise.allSettled([
    session.connection.setPermissionMode(fallback, options),
    session.connection.setPermissionMode('bypassPermissions', options)
  ])
  if (fallbackWrite.status === 'rejected') {
    throw fallbackWrite.reason
  }
  if (bypassWrite.status === 'fulfilled') {
    session.bypassDisabled = false
    return 'bypassPermissions'
  }
  if (!isClaudeBypassRefusal(bypassWrite.reason)) {
    throw bypassWrite.reason
  }
  session.bypassDisabled = true
  return fallback
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

export function claudeFullAccessRefusalRow(session: ClaudeBypassFacts): AgentJournalStatusItem {
  const choice = readClaudeReportedPermissionMode({
    type: 'system',
    subtype: 'init',
    permissionMode: claudeAllowedPermissionMode(session, 'bypassPermissions')
  })
  const running = isAgentChatPermissionMode(choice)
    ? agentChatPermissionModeCopy('claude', choice).label
    : 'its own permission settings'
  return {
    kind: 'status',
    tone: 'warning',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text: `Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses ${running} instead.`
  }
}

/** One warning row on the first root init after Claude's refusal is known. */
export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'fullAccessRefusalNotice'>,
  idPrefix: string,
  turnScope: AgentJournalTurnScope
): void {
  const body = deps.fullAccessRefusalNotice?.()
  if (!body) {
    return
  }
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `full-access-refused:claude:${idPrefix}` },
    body,
    { turnScope }
  )
  deps.sink.publish()
}
