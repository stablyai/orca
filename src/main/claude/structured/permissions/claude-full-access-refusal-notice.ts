import { randomUUID } from 'node:crypto'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import type { JournalSqlReads } from '../../../native-chat/agent-session-journal/journal-sql-reads'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type { ClaudeJournalTranslatorDeps } from '../journal/claude-journal-translator-contract'
import {
  claudeAutoFallbackReason,
  claudeBypassRefused,
  claudeFullAccessRefusalReason,
  type ClaudeBypassFacts
} from './claude-full-access-refusal'

type ClaudeNoticeState = Pick<
  ClaudeSession,
  'fullAccessRefusalNoticeId' | 'fullAccessRefusalNotices'
>

export type ClaudeFullAccessRefusalNotice = { id: string; body: AgentJournalStatusItem }

const CLAUDE_REFUSAL_NOTICE_PREFIX = 'full-access-refused:claude:'
const CLAUDE_REFUSAL_NOTICE_TIMED = 't'
const EARLIER_PROCESS_WARNING = 'earlier-process'

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
function claudeFullAccessRefusalNoticeId(session: ClaudeBypassFacts): string | null {
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
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

function claudeAutoRefusalNotice(session: ClaudeBypassFacts): ClaudeFullAccessRefusalNotice | null {
  if (session.appliedInputOptions?.get('buildPermissionMode') !== 'default') {
    return null
  }
  const reason = claudeAutoFallbackReason(session)
  if (reason === null) {
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
  session: ClaudeBypassFacts & ClaudeNoticeState
): ClaudeFullAccessRefusalNotice | null {
  const intent = session.launchIntent?.permissionMode
  if (
    session.fullAccessRefusalNoticeId !== EARLIER_PROCESS_WARNING ||
    (intent !== 'auto' && intent !== 'bypassPermissions') ||
    session.firstRootInit?.permissionMode !== intent ||
    claudeBypassRefused(session) ||
    claudeAutoFallbackReason(session) !== null
  ) {
    return null
  }
  const choice = intent === 'auto' ? 'auto' : 'full-access'
  return claimClaudePermissionNotice(session, {
    id: `restored:${intent}`,
    body: claudePermissionNoticeRow(
      'notice',
      `Claude uses ${agentChatPermissionModeCopy('claude', choice).label} again.`
    )
  })
}

export async function readClaudeEarlierRefusalNotice(
  session: Pick<ClaudeSession, 'launchIntent'> & ClaudeNoticeState,
  reads: Pick<JournalSqlReads, 'newestItemId'> | undefined,
  assertCurrent: () => void
): Promise<void> {
  const intent = session.launchIntent?.permissionMode
  if (intent !== 'auto' && intent !== 'bypassPermissions') {
    return
  }
  const prefix = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: CLAUDE_REFUSAL_NOTICE_PREFIX
  })
  const prior = reads?.newestItemId(prefix, CLAUDE_REFUSAL_NOTICE_TIMED)
  const result = await prior?.catch((error: unknown) => {
    console.warn('[claude] reading the last permission warning failed:', error)
    return null
  })
  assertCurrent()
  const notices = (session.fullAccessRefusalNotices ??= { process: randomUUID(), count: 0 })
  if (!result) {
    return
  }
  const { itemId, greatestTimedId } = result
  const parts = (key: string | null) => {
    const identity = key === null ? null : parseAgentJournalItemKey(key)
    return identity?.provider === 'orca'
      ? identity.clientMessageId.slice(CLAUDE_REFUSAL_NOTICE_PREFIX.length).split(':')
      : []
  }
  const [timed] = parts(greatestTimedId)
  const after = Number.parseInt(timed?.slice(1) ?? '', 36)
  if (Number.isFinite(after)) {
    notices.after = Math.max(notices.after ?? 0, after)
  }
  const newest = parts(itemId)
  const id = newest[newest[0]?.startsWith(CLAUDE_REFUSAL_NOTICE_TIMED) ? 3 : 2]
  const warning =
    intent === 'auto'
      ? id?.startsWith('auto-')
      : /^(settings|restricted|not-launched|started-outside|running)$/.test(id ?? '')
  if (warning) {
    session.fullAccessRefusalNoticeId ??= EARLIER_PROCESS_WARNING
  }
}

export function claimClaudeFullAccessRefusalNotice(
  session: ClaudeBypassFacts & ClaudeNoticeState
): ClaudeFullAccessRefusalNotice | null {
  if (!session.fullAccessRefusalNotices) {
    return null
  }
  const restored = claimClaudePermissionRestored(session)
  if (restored) {
    return restored
  }
  if (session.launchIntent?.permissionMode === 'auto') {
    const notice = claudeAutoRefusalNotice(session)
    return notice && claimClaudePermissionNotice(session, notice)
  }
  const id = claudeFullAccessRefusalNoticeId(session)
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
  if (id === null || applied === undefined || id === session.fullAccessRefusalNoticeId) {
    return null
  }
  return claimClaudePermissionNotice(session, {
    id,
    body: claudePermissionNoticeRow(
      'warning',
      claudeFullAccessRefusalText(session, claudeFallbackChoice(applied))
    )
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

export function journalClaudeFullAccessRefusal(
  deps: Pick<ClaudeJournalTranslatorDeps, 'sink' | 'fullAccessRefusalNotice'>,
  turnScope: AgentJournalTurnScope
): void {
  const notice = deps.fullAccessRefusalNotice?.()
  if (!notice) {
    return
  }
  deps.sink.appendItem(
    { provider: 'orca', clientMessageId: `${CLAUDE_REFUSAL_NOTICE_PREFIX}${notice.id}` },
    notice.body,
    { turnScope }
  )
  deps.sink.publish()
}
