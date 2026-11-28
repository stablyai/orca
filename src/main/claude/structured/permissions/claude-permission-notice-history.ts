import { randomUUID } from 'node:crypto'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalSqlReads } from '../../../native-chat/agent-session-journal/journal-sql-reads'
import type { ClaudeSession } from '../claude-structured-session-state'
import {
  CLAUDE_PERMISSION_HISTORY_UNREAD,
  CLAUDE_REFUSAL_NOTICE_PREFIX,
  CLAUDE_REFUSAL_NOTICE_TIMED,
  EARLIER_PROCESS_WARNING,
  type ClaudeNoticeState
} from './claude-full-access-refusal-notice'

/** The chat's last saved permission row, read once at open (one retry): an earlier process's
 *  warning or recovery decides whether this process says "again" or warns afresh. Two failed
 *  reads leave the history unread, which is never taken for a saved row or a mode. */
export async function readClaudeEarlierRefusalNotice(
  session: Pick<ClaudeSession, 'launchIntent' | 'delivery'> & ClaudeNoticeState,
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
  const read = () => reads?.newestItemId(prefix, CLAUDE_REFUSAL_NOTICE_TIMED)
  let unread = false
  const result = await read()?.catch(() => {
    assertCurrent()
    if (!session.delivery.ready) {
      return null
    }
    return read()?.catch((error: unknown) => {
      console.warn('[claude] reading the last permission warning failed:', error)
      unread = true
      return null
    })
  })
  assertCurrent()
  const notices = (session.fullAccessRefusalNotices ??= { process: randomUUID(), count: 0 })
  if (unread) {
    session.fullAccessRefusalNoticeId ??= CLAUDE_PERMISSION_HISTORY_UNREAD
    return
  }
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
  const notice = newest.slice(newest[0]?.startsWith(CLAUDE_REFUSAL_NOTICE_TIMED) ? 3 : 2)
  const [id] = notice
  const warning =
    intent === 'auto'
      ? id?.startsWith('auto-')
      : /^(settings|restricted|not-launched|started-outside|running)$/.test(id ?? '')
  const restored = `restored:${intent}`
  if (warning || notice.join(':') === restored) {
    session.fullAccessRefusalNoticeId ??= warning ? EARLIER_PROCESS_WARNING : restored
  }
}
