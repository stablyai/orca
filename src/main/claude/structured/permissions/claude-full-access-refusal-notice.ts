// The warning a Full access or Approve for me chat gets, as a new row, when Claude runs it in
// another mode.

import { randomUUID } from 'node:crypto'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'
import {
  claudeAutoFallsBack,
  claudeAutoRefused,
  claudeBypassRefused,
  claudeFullAccessRefusalReason,
  type ClaudeBypassFacts
} from './claude-full-access-refusal'

type ClaudeNoticeFacts = ClaudeBypassFacts &
  Partial<Pick<ClaudeSession, 'appliedInputOptions' | 'reportedOptions'>>

export type ClaudeFullAccessRefusalNotice = { id: string; body: AgentJournalStatusItem }

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
  if (session.launchIntent?.permissionMode === 'auto') {
    return claudeAutoFallsBack(session) && applied !== undefined && applied !== 'auto'
      ? `auto-${claudeAutoFallbackReason(session)}:${claudeFallbackChoice(applied)}`
      : null
  }
  if (!claudeBypassRefused(session) || applied === undefined || applied === 'bypassPermissions') {
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
  return `${claudeFullAccessRefusalReason(session)}:${choice}${auto}`
}

/** Why an Approve for me chat runs in Ask: its settings, its start, or a refusal only for now. */
function claudeAutoFallbackReason(
  session: ClaudeNoticeFacts
): 'settings' | 'started-outside' | 'for-now' {
  return session.autoDisabled === true
    ? 'settings'
    : claudeAutoRefused(session)
      ? 'started-outside'
      : 'for-now'
}

function claudeAutoFallbackText(session: ClaudeNoticeFacts, running: string): string {
  switch (claudeAutoFallbackReason(session)) {
    case 'settings':
      return `Claude's settings turn off Approve for me (disableAutoMode), so Claude uses ${running} instead.`
    case 'started-outside':
      return `Claude didn't start this chat in Approve for me, so Claude uses ${running} instead.`
    case 'for-now':
      return `Approve for me isn't available right now, so Claude uses ${running} instead.`
  }
}

function claudeFullAccessRefusalText(session: ClaudeNoticeFacts, choice: string): string {
  const running = isAgentChatPermissionMode(choice)
    ? agentChatPermissionModeCopy('claude', choice).label
    : 'its own permission settings'
  if (session.launchIntent?.permissionMode === 'auto') {
    return claudeAutoFallbackText(session, running)
  }
  const reason = claudeFullAccessRefusalReason(session)
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
        : reason === 'started-outside'
          ? "Claude didn't start this chat in Full access"
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

/** The warning this chat is due when it differs from the last one this process wrote. Every
 *  warning is a new row at the bottom, never a revision of an earlier one, so the newest row
 *  always names the mode Claude runs now; a new process repeats it there. */
export function claimClaudeFullAccessRefusalNotice(
  session: ClaudeNoticeFacts &
    Pick<ClaudeSession, 'fullAccessRefusalNoticeId' | 'fullAccessRefusalNotices'>
): ClaudeFullAccessRefusalNotice | null {
  const id = claudeFullAccessRefusalNoticeId(session)
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
  const previous = session.fullAccessRefusalNoticeId
  if (id === null || applied === undefined || id === previous) {
    return null
  }
  session.fullAccessRefusalNoticeId = id
  const notices = (session.fullAccessRefusalNotices ??= { process: randomUUID(), count: 0 })
  notices.count += 1
  return {
    id: `${notices.process}:${notices.count}:${id}`,
    body: claudeFullAccessRefusalRow(session, applied)
  }
}

/** Checked on every root frame; writes only the warning the chat is due. */
export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'fullAccessRefusalNotice'>,
  turnScope: AgentJournalTurnScope
): void {
  const notice = deps.fullAccessRefusalNotice?.()
  if (!notice) {
    return
  }
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `full-access-refused:claude:${notice.id}` },
    notice.body,
    { turnScope }
  )
  deps.sink.publish()
}
