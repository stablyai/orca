import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'
import {
  claudeAutoFallbackReason,
  claudeBypassRefused,
  claudeFullAccessRefusalReason,
  claudeInPlan,
  type ClaudeBypassFacts
} from './claude-full-access-refusal'
import { claudeChildPermissionCut } from './claude-permission-dispatch-authority'

export type ClaudeNoticeState = Pick<
  ClaudeSession,
  'fullAccessRefusalNoticeId' | 'fullAccessRefusalNotices'
>

type ClaudeNoticeFacts = Parameters<typeof claudeInPlan>[0] & Pick<ClaudeSession, 'startupSettings'>

export type ClaudeFullAccessRefusalNotice = { id: string; body: AgentJournalStatusItem }

export const CLAUDE_REFUSAL_NOTICE_PREFIX = 'full-access-refused:claude:'
export const CLAUDE_REFUSAL_NOTICE_TIMED = 't'
export const EARLIER_PROCESS_WARNING = 'earlier-process'
export const CLAUDE_AUTO_RESTORED_NOTICE_ID = 'restored:auto'
export const CLAUDE_FULL_ACCESS_RESTORED_NOTICE_ID = 'restored:bypassPermissions'
const PENDING_FULL_ACCESS_UNCONFIRMED = 'pending-full-access-unconfirmed'
/** Both reads of the saved rows failed: in memory only, never a row id or a permission fact. */
export const CLAUDE_PERMISSION_HISTORY_UNREAD = 'history-unread'
type ClaudeFullAccessFallback = 'unconfirmed'

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

function claudeFullAccessRefusalText(session: ClaudeBypassFacts, choice: string): string {
  const running = isAgentChatPermissionMode(choice)
    ? agentChatPermissionModeCopy('claude', choice).label
    : 'its own permission settings'
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

function claudePermissionNoticeRow(
  tone: 'warning' | 'notice',
  text: string
): AgentJournalStatusItem {
  return {
    kind: 'status',
    tone,
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text
  }
}

function claudeAutoRefusalNotice(session: ClaudeNoticeFacts): ClaudeFullAccessRefusalNotice | null {
  const applied = session.appliedInputOptions.get('buildPermissionMode')
  const reason = claudeAutoFallbackReason(session)
  if (
    reason === null ||
    claudeInPlan(session) ||
    (reason === 'started-outside' && session.autoDisabled === undefined && session.startupSettings)
  ) {
    return null
  }
  const reported = session.reportedOptions.reportedPermissionMode
  const settingsAsk =
    reason === 'settings' &&
    applied === undefined &&
    (reported === 'ask' ||
      (reported === undefined &&
        session.permissionModeRequests === undefined &&
        session.firstRootInit?.permissionMode === 'default'))
  if (applied !== 'default' && !settingsAsk) {
    return null
  }
  const refusal =
    reason === 'settings'
      ? "Claude's settings turn off Approve for me (disableAutoMode)"
      : reason === 'for-now'
        ? "Approve for me isn't available right now"
        : "Claude didn't start this chat in Approve for me"
  return {
    id: `auto-${reason}:ask`,
    body: claudePermissionNoticeRow(
      'warning',
      `${refusal}, so Claude uses Ask for approval instead.`
    )
  }
}

function claimClaudePermissionRestored(
  session: ClaudeNoticeFacts & ClaudeNoticeState
): ClaudeFullAccessRefusalNotice | null {
  const intent = session.launchIntent?.permissionMode
  const restoredAtStartup =
    (session.permissionModeRequests ?? 0) === 0 &&
    session.actualFirstRootInit?.permissionMode === intent &&
    !claudeInPlan(session)
  if (
    (intent !== 'auto' && intent !== 'bypassPermissions') ||
    session.fullAccessRefusalNoticeId !== EARLIER_PROCESS_WARNING ||
    session.appliedInputOptions.get('interactionMode') === 'plan' ||
    (!restoredAtStartup && session.acknowledgedBuildPermissionMode !== intent) ||
    claudeBypassRefused(session) ||
    claudeAutoFallbackReason(session) !== null
  ) {
    return null
  }
  const choice = intent === 'auto' ? 'auto' : 'full-access'
  return claimClaudePermissionNotice(session, {
    id: intent === 'auto' ? CLAUDE_AUTO_RESTORED_NOTICE_ID : CLAUDE_FULL_ACCESS_RESTORED_NOTICE_ID,
    body: claudePermissionNoticeRow(
      'notice',
      `Claude uses ${agentChatPermissionModeCopy('claude', choice).label} again.`
    )
  })
}

export function claimClaudeFullAccessRefusalNotice(
  session: ClaudeSession,
  fallback?: ClaudeFullAccessFallback
): ClaudeFullAccessRefusalNotice | null {
  // A settings reply or late frame after the child's cut speaks for no live child.
  if (claudeChildPermissionCut(session)) {
    return null
  }
  if (!session.initialization.startup.opened() || !session.fullAccessRefusalNotices) {
    if (fallback === 'unconfirmed' && session.fullAccessRefusalNotices) {
      session.fullAccessRefusalNoticeId = PENDING_FULL_ACCESS_UNCONFIRMED
    }
    return null
  }
  const restored = claimClaudePermissionRestored(session)
  if (restored) {
    return restored
  }
  if (session.launchIntent?.permissionMode === 'auto') {
    const notice = claudeAutoRefusalNotice(session)
    // A reply after the deadline can explain the same Ask fallback already shown.
    if (
      notice?.id === 'auto-settings:ask' &&
      session.fullAccessRefusalNoticeId === 'auto-started-outside:ask'
    ) {
      return null
    }
    return notice && claimClaudePermissionNotice(session, notice)
  }
  const applied = session.appliedInputOptions.get('buildPermissionMode')
  if (
    fallback === 'unconfirmed' ||
    (applied === undefined && session.fullAccessRefusalNoticeId === PENDING_FULL_ACCESS_UNCONFIRMED)
  ) {
    return claimClaudePermissionNotice(session, {
      id: 'running:unconfirmed',
      body: claudePermissionNoticeRow(
        'warning',
        "Full access is off, and Claude hasn't confirmed which approval mode it uses."
      )
    })
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
  const id = `${claudeFullAccessRefusalReason(session)}:${choice}${auto}`
  if (id === session.fullAccessRefusalNoticeId) {
    return null
  }
  return claimClaudePermissionNotice(session, {
    id,
    body: claudePermissionNoticeRow('warning', claudeFullAccessRefusalText(session, choice))
  })
}

function claimClaudePermissionNotice(
  session: ClaudeNoticeState,
  notice: ClaudeFullAccessRefusalNotice
): ClaudeFullAccessRefusalNotice | null {
  const notices = session.fullAccessRefusalNotices
  if (!notices || notice.id === session.fullAccessRefusalNoticeId) {
    return null
  }
  session.fullAccessRefusalNoticeId = notice.id
  notices.count += 1
  const time = Math.max(Date.now(), (notices.after ?? 0) + 1)
  notices.after = time
  const timed = `${CLAUDE_REFUSAL_NOTICE_TIMED}${time.toString(36).padStart(10, '0')}`
  return {
    id: `${timed}:${notices.process}:${notices.count}:${notice.id}`,
    body: notice.body
  }
}

/** Checked on every root frame; writes only the warning the chat is due. The scope is read only
 *  when one is due: building it per streamed delta was a measurable share of main's chat work. */
export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'fullAccessRefusalNotice'>,
  turnScope: () => AgentJournalTurnScope
): void {
  const notice = deps.fullAccessRefusalNotice?.()
  if (!notice) {
    return
  }
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `${CLAUDE_REFUSAL_NOTICE_PREFIX}${notice.id}` },
    notice.body,
    { turnScope: turnScope() }
  )
  deps.sink.publish()
}

export function journalClaudeSessionPermissionNotice(
  session: ClaudeSession,
  turnScope: AgentJournalTurnScope = session.translator?.currentTurnScope() ?? { kind: 'thread' },
  fallback?: ClaudeFullAccessFallback
): void {
  if (session.events && session.delivery.ready) {
    journalClaudeFullAccessRefusal(
      {
        sink: session.events,
        fullAccessRefusalNotice: () => claimClaudeFullAccessRefusalNotice(session, fallback)
      },
      () => turnScope
    )
  }
}
