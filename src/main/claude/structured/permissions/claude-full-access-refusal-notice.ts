// The once-per-mode warning a Full access chat gets when Claude runs it in another mode.

import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'
import { claudeBypassRefused, type ClaudeBypassFacts } from './claude-full-access-refusal'

type ClaudeNoticeFacts = ClaudeBypassFacts &
  Partial<Pick<ClaudeSession, 'appliedInputOptions' | 'reportedOptions'>>

export type ClaudeFullAccessRefusalNotice = {
  id: string
  /** Which change of this process's warning, absent for its first. */
  change?: number
  body: AgentJournalStatusItem
}

/** The chat's permission mode for the fallback Claude accepted. */
function claudeFallbackChoice(applied: string): string {
  return (
    readClaudeReportedPermissionMode({
      type: 'system',
      subtype: 'init',
      permissionMode: applied
    }) ?? applied
  )
}

/** Which warning the chat is due, if any: one per mode Claude runs it in and per reason, so a
 *  change of either says so while repeats of the same one do not. Waits for a first fallback
 *  attempt, Plan exit included, so it names a mode Claude accepted. */
function claudeFullAccessRefusalNoticeId(session: ClaudeNoticeFacts): string | null {
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
  if (!claudeBypassRefused(session) || applied === undefined) {
    return null
  }
  const choice = claudeFallbackChoice(applied)
  const auto =
    choice !== 'ask'
      ? ''
      : session.autoDisabled === true
        ? ':auto-off'
        : session.autoUnsettled !== undefined
          ? ':auto-for-now'
          : ''
  return `${session.bypassRefusal ?? 'settings'}:${choice}${auto}`
}

function claudeFullAccessRefusalText(session: ClaudeNoticeFacts, choice: string): string {
  const running = isAgentChatPermissionMode(choice)
    ? agentChatPermissionModeCopy('claude', choice).label
    : 'its own permission settings'
  const reason = session.bypassRefusal ?? 'settings'
  const autoOff = choice === 'ask' && session.autoDisabled === true
  const autoForNow = choice === 'ask' && !autoOff && session.autoUnsettled !== undefined
  if (reason === 'settings' && autoOff) {
    return `Claude's settings turn off Full access and Approve for me (permissions.disableBypassPermissionsMode, disableAutoMode), so Claude uses ${running} instead.`
  }
  const bypass =
    reason === 'restricted'
      ? 'Claude does not allow Full access in restricted mode'
      : reason === 'not-launched'
        ? 'This Claude session was not started with Full access'
        : "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode)"
  const auto = autoOff
    ? ", and Claude's settings turn off Approve for me (disableAutoMode)"
    : autoForNow
      ? " and Approve for me isn't available right now"
      : ''
  return `${bypass}${auto}, so Claude uses ${running} instead.`
}

function claudeFullAccessRefusalRow(
  session: ClaudeNoticeFacts,
  applied: string
): AgentJournalStatusItem {
  return {
    kind: 'status',
    tone: 'warning',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text: claudeFullAccessRefusalText(session, claudeFallbackChoice(applied))
  }
}

/** The warning this chat is due when it differs from the last one this process wrote. A first
 *  warning keeps one journal identity, so a relaunch that finds the chat as it started revises
 *  that row instead of adding another; each later change is a new row where it happens. */
export function claimClaudeFullAccessRefusalNotice(
  session: ClaudeNoticeFacts &
    Pick<ClaudeSession, 'fullAccessRefusalNoticeId' | 'fullAccessRefusalNoticeChanges'>
): ClaudeFullAccessRefusalNotice | null {
  const id = claudeFullAccessRefusalNoticeId(session)
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
  const previous = session.fullAccessRefusalNoticeId
  if (id === null || applied === undefined || id === previous) {
    return null
  }
  session.fullAccessRefusalNoticeId = id
  const body = claudeFullAccessRefusalRow(session, applied)
  if (previous === undefined) {
    return { id, body }
  }
  const change = (session.fullAccessRefusalNoticeChanges ?? 0) + 1
  session.fullAccessRefusalNoticeChanges = change
  return { id: `${previous}->${id}`, change, body }
}

/** Checked on every root frame; writes only the warning the chat is due. */
export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'fullAccessRefusalNotice'>,
  idPrefix: string,
  turnScope: AgentJournalTurnScope
): void {
  const notice = deps.fullAccessRefusalNotice?.()
  if (!notice) {
    return
  }
  const change = notice.change === undefined ? '' : `#${idPrefix}:${notice.change}`
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `full-access-refused:claude:${notice.id}${change}` },
    notice.body,
    { turnScope }
  )
  deps.sink.publish()
}
