import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalSqlReads } from '../../../native-chat/agent-session-journal/journal-sql-reads'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../../shared/agent-session/journal/agent-session-turn-notice'
import { isAgentChatPermissionMode } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentChatPermissionModeCopy } from '../../../../shared/agent-session/options/permissions/structured-agent-session-permission-option'
import { readClaudeReportedPermissionMode } from '../startup/claude-structured-init-proof'
import type { ClaudeSession } from '../claude-structured-session-state'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudePermissionNoticeIntent } from './claude-permission-notice-mode'
import {
  claudeAutoRefused,
  claudeBypassRefused,
  claudeFullAccessRefusalReason,
  type ClaudeBypassFacts
} from './claude-full-access-refusal'

const CLAUDE_REFUSAL_NOTICE_PREFIX = 'full-access-refused:claude:'
// An earlier process's warning that no row since has answered.
const EARLIER_PROCESS_WARNING = 'earlier-process'
const CLAUDE_REFUSAL_NOTICE_READ_RETRY_MS = 1_000
// Row ids from this marker on lead with a time; older builds' ids lead with a hex process id.
const CLAUDE_REFUSAL_NOTICE_TIMED = 't'

export type ClaudePermissionNoticeSession = ClaudeBypassFacts &
  Pick<
    ClaudeSession,
    | 'permissionNoticeMode'
    | 'permissionNoticeSeeded'
    | 'recheckPermissionNotice'
    | 'fullAccessRefusalNoticeId'
    | 'fullAccessRefusalNotices'
  >

function claudeNoticeChoice(mode: string): string {
  return (
    readClaudeReportedPermissionMode({
      type: 'system',
      subtype: 'init',
      permissionMode: mode
    }) ?? mode
  )
}

function claudePermissionLabel(mode: string): string {
  const choice = claudeNoticeChoice(mode)
  if (isAgentChatPermissionMode(choice)) {
    return agentChatPermissionModeCopy('claude', choice).label
  }
  return mode === 'dontAsk' ? "Don't ask" : 'its own permission settings'
}

function claudeAutoFallbackReason(
  session: ClaudePermissionNoticeSession
): 'settings' | 'started-outside' | 'for-now' | 'running' {
  const mode = session.permissionNoticeMode
  const refused = mode?.refused('auto')
  const startedOutside = !mode?.hasRun('auto')
  if (session.autoDisabled === true && (startedOutside || refused)) {
    return 'settings'
  }
  if (refused && session.autoUnsettled !== undefined) {
    return 'for-now'
  }
  return startedOutside && claudeAutoRefused(session) ? 'started-outside' : 'running'
}

function claudeAutoFallbackText(
  reason: ReturnType<typeof claudeAutoFallbackReason>,
  running: string
): string {
  switch (reason) {
    case 'settings':
      return `Claude's settings turn off Approve for me (disableAutoMode), so Claude uses ${running} instead.`
    case 'started-outside':
      return `Claude didn't start this chat in Approve for me, so Claude uses ${running} instead.`
    case 'for-now':
      return `Approve for me isn't available right now, so Claude uses ${running} instead.`
    case 'running':
      return `Claude uses ${running} instead.`
  }
}

function claudeBypassFallbackNotice(
  session: ClaudePermissionNoticeSession,
  running: string,
  label: string
): { id: string; text: string } {
  const mode = session.permissionNoticeMode
  const hasRun = mode?.hasRun('bypassPermissions')
  const reason =
    (!hasRun && claudeBypassRefused(session)) ||
    (mode?.refused('bypassPermissions') && session.bypassRefusal)
      ? claudeFullAccessRefusalReason(session)
      : null
  if (reason === null) {
    return { id: `running:${running}`, text: `Claude uses ${label} instead.` }
  }
  const autoOff =
    running === 'default' &&
    session.autoDisabled === true &&
    (!mode?.hasRun('auto') || mode.refused('auto'))
  const autoForNow =
    running === 'default' &&
    !autoOff &&
    mode?.refused('auto') &&
    session.autoUnsettled !== undefined
  const id = `${reason}:${claudeNoticeChoice(running)}${autoOff ? ':auto-off' : autoForNow ? ':auto-for-now' : ''}`
  if (reason === 'settings' && autoOff) {
    return {
      id,
      text: `Claude's settings turn off Full access and Approve for me (permissions.disableBypassPermissionsMode, disableAutoMode), so Claude uses ${label} instead.`
    }
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
  return { id, text: `${bypass}${auto}, so Claude uses ${label} instead.` }
}

function claudePermissionNoticeRow(
  id: string,
  text: string,
  tone: 'warning' | 'notice' = 'notice'
): { id: string; body: AgentJournalStatusItem } {
  return {
    id,
    body: { kind: 'status', tone, presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION, text }
  }
}

function claudePermissionNotice(
  session: ClaudePermissionNoticeSession,
  intent: ClaudePermissionNoticeIntent
): ReturnType<typeof claudePermissionNoticeRow> | null {
  const tracker = session.permissionNoticeMode
  if (!tracker || !session.permissionNoticeSeeded) {
    return null
  }
  const running = tracker.running()
  if (running === undefined || running === 'plan' || running === intent) {
    if (session.fullAccessRefusalNoticeId === undefined) {
      return null
    }
    if (running === undefined) {
      return tracker.unconfirmed()
        ? claudePermissionNoticeRow(
            `unconfirmed:${intent}`,
            "Claude's permission mode is unconfirmed."
          )
        : null
    }
    if (running === 'plan') {
      return claudePermissionNoticeRow(`plan:${intent}`, 'Claude uses Plan mode.')
    }
    return claudePermissionNoticeRow(
      `restored:${intent}`,
      `Claude uses ${claudePermissionLabel(intent)} again.`
    )
  }
  const label = claudePermissionLabel(running)
  if (intent === 'auto') {
    const reason = claudeAutoFallbackReason(session)
    return claudePermissionNoticeRow(
      `auto-${reason}:${claudeNoticeChoice(running)}`,
      claudeAutoFallbackText(reason, label),
      'warning'
    )
  }
  const applied = session.appliedInputOptions?.get('buildPermissionMode')
  // A refused Full access launch owes its first settled fallback, including on Plan exit.
  if (!tracker.hasRun(intent) && (applied === undefined || applied === intent)) {
    return null
  }
  const { id, text } = claudeBypassFallbackNotice(session, running, label)
  return claudePermissionNoticeRow(id, text, 'warning')
}

/** Leads each row id so the chat's newest row has the greatest id; it sorts after older rows
 *  whose ids led with a hex process id. */
function claudeRefusalNoticeTime(notices: { after?: number }): string {
  // Never at or before the chat's newest row, so a clock set back keeps the order.
  const time = Math.max(Date.now(), (notices.after ?? 0) + 1)
  notices.after = time
  return `${CLAUDE_REFUSAL_NOTICE_TIMED}${time.toString(36).padStart(10, '0')}`
}

/** Reads the chat's newest warning row once per process start: when an earlier process's warning
 *  for this mode is still the newest, a run in the chat's choice says so in a new row. */
async function readClaudeEarlierRefusalNotice(
  session: Pick<
    ClaudeSession,
    'launchIntent' | 'fullAccessRefusalNoticeId' | 'fullAccessRefusalNotices'
  >,
  reads: Pick<JournalSqlReads, 'newestItemId'> | undefined
): Promise<void> {
  const intent = session.launchIntent?.permissionMode
  if (!reads || (intent !== 'auto' && intent !== 'bypassPermissions')) {
    return
  }
  const prefix = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: CLAUDE_REFUSAL_NOTICE_PREFIX
  })
  // One retry: a journal reader can be replaced while it answers.
  const { itemId, greatestTimedId } = await reads
    .newestItemId(prefix, CLAUDE_REFUSAL_NOTICE_TIMED)
    .catch(async () =>
      delay(CLAUDE_REFUSAL_NOTICE_READ_RETRY_MS, undefined, { ref: false }).then(() =>
        reads.newestItemId(prefix, CLAUDE_REFUSAL_NOTICE_TIMED)
      )
    )
  // `t<time>:<process>:<count>:<warning id>`, or `<process>:<count>:<warning id>` before times led
  const parts = (id: string) => decodeURIComponent(id.slice(prefix.length)).split(':')
  if (greatestTimedId !== null) {
    const after = Number.parseInt(parts(greatestTimedId)[0].slice(1), 36)
    const notices = (session.fullAccessRefusalNotices ??= { process: randomUUID(), count: 0 })
    notices.after = Math.max(notices.after ?? 0, Number.isFinite(after) ? after : 0)
  }
  if (itemId === null) {
    return
  }
  const newest = parts(itemId)
  const id = newest.slice(newest[0]?.startsWith(CLAUDE_REFUSAL_NOTICE_TIMED) ? 3 : 2).join(':')
  if (/^(restored|plan|unconfirmed):/.test(id)) {
    if (id.split(':')[1] === intent) {
      session.fullAccessRefusalNoticeId = id
    }
  } else if (id.startsWith('auto-') === (intent === 'auto')) {
    session.fullAccessRefusalNoticeId = EARLIER_PROCESS_WARNING
  }
}

export async function seedClaudePermissionNotice(
  session: ClaudePermissionNoticeSession,
  reads: Pick<JournalSqlReads, 'newestItemId'> | undefined,
  assertCurrent: () => void
): Promise<void> {
  await readClaudeEarlierRefusalNotice(session, reads).catch((error: unknown) =>
    console.warn('[claude] reading the last permission warning failed:', error)
  )
  assertCurrent()
  session.permissionNoticeSeeded = true
  session.recheckPermissionNotice?.()
}

export function journalClaudeFullAccessRefusal(
  sink: StructuredAgentSessionEventSink,
  session: ClaudePermissionNoticeSession | null | undefined,
  turnScope: AgentJournalTurnScope
): StructuredAgentSessionSinkAdmission {
  const intent = session?.launchIntent?.permissionMode
  if (!session || (intent !== 'auto' && intent !== 'bypassPermissions')) {
    return { accepted: true }
  }
  const notice = claudePermissionNotice(session, intent)
  if (!notice || notice.id === session.fullAccessRefusalNoticeId) {
    return { accepted: true }
  }
  const notices = session.fullAccessRefusalNotices ?? { process: randomUUID(), count: 0 }
  const next = { ...notices, count: notices.count + 1 }
  const time = claudeRefusalNoticeTime(next)
  const count = String(next.count).padStart(6, '0')
  const identity = {
    provider: 'orca',
    clientMessageId: `${CLAUDE_REFUSAL_NOTICE_PREFIX}${time}:${next.process}:${count}:${notice.id}`
  } as const
  const options = { turnScope }
  const result = sink.tryAppendItem?.(identity, notice.body, options)
  if (result && !result.accepted) {
    return result
  }
  if (!result) {
    sink.appendItem(identity, notice.body, options)
  }
  session.fullAccessRefusalNoticeId = notice.id
  session.fullAccessRefusalNotices = next
  sink.publish()
  return { accepted: true }
}
