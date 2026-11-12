/** Chat approvals Orca reported open. Each closes as soon as its journal item settles: answered in
 *  the worker's own chat, or gone. Orca's own answers write their closing lines themselves. */
import type { AgentSessionJournal } from '../../../../native-chat/agent-session-journal/journal-store'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { subscribeForRedrive } from '../../mailbox/structured-pointer/structured-session-journal-redrive'
import { structuredMailboxCustody } from '../../mailbox/routing/structured-session-mail-target'
import type { WorkerTurnStopReportDeps } from '../turn-stops/worker-turn-stop-report'
import {
  chatApprovalCloseOutcome,
  readChatWorkerPrompt,
  type ChatWorkerPromptReader
} from './chat-worker-approval-prompt'
import {
  TERMINAL_APPROVAL_ID_PREFIX,
  approvalReportId,
  closeReportedApproval,
  recentOpenApprovalReports
} from './worker-approval-report'

export type ChatJournalWatch = (
  sessionId: string,
  onChange: () => void,
  relevant: (journal: AgentSessionJournal) => boolean
) => () => void

const watchHostJournal: ChatJournalWatch = (sessionId, onChange, relevant) => {
  const host = getStructuredAgentSessionHost()
  return host ? subscribeForRedrive(host, sessionId, onChange, relevant) : () => {}
}

type WatchedSession = { approvals: Map<string, Set<string>>; stop: () => void }

export class ChatWorkerApprovalWatch {
  private readonly sessions = new Map<string, WatchedSession>()

  constructor(
    private readonly deps: Pick<WorkerTurnStopReportDeps, 'getDb' | 'notify'> & {
      readPrompt?: ChatWorkerPromptReader
      watchJournal?: ChatJournalWatch
      signal: AbortSignal
    }
  ) {
    deps.signal.addEventListener(
      'abort',
      () => {
        for (const session of this.sessions.values()) {
          session.stop()
        }
        this.sessions.clear()
      },
      { once: true }
    )
  }

  track(sessionId: string, approvalId: string, dispatchId: string): void {
    if (this.deps.signal.aborted) {
      return
    }
    let session = this.sessions.get(sessionId)
    if (!session) {
      const approvals = new Map<string, Set<string>>()
      const watch = this.deps.watchJournal ?? watchHostJournal
      session = {
        approvals,
        stop: watch(
          sessionId,
          () => void this.check(sessionId),
          (journal) =>
            [...approvals.keys()].some((id) => {
              const body = journal.itemBody(id)
              return body?.kind !== 'approval' || body.resolution.state !== 'pending'
            })
        )
      }
      if (this.deps.signal.aborted) {
        session.stop()
        return
      }
      this.sessions.set(sessionId, session)
    }
    const dispatchIds = session.approvals.get(approvalId) ?? new Set<string>()
    dispatchIds.add(dispatchId)
    session.approvals.set(approvalId, dispatchIds)
  }

  async check(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || this.deps.signal.aborted) {
      return
    }
    for (const [approvalId, dispatchIds] of session.approvals) {
      // An unreadable chat proves nothing: keep watching.
      const prompt = await (this.deps.readPrompt ?? readChatWorkerPrompt)(
        sessionId,
        approvalId
      ).catch(() => undefined)
      if (this.deps.signal.aborted) {
        return
      }
      if (prompt === undefined || prompt?.body.resolution.state === 'pending') {
        continue
      }
      const outcome = chatApprovalCloseOutcome(prompt)
      const db = this.deps.getDb()
      if (outcome && !db) {
        // Keep it: the next journal change retries once the database is back.
        continue
      }
      if (outcome && db) {
        for (const dispatchId of dispatchIds) {
          if (this.deps.signal.aborted) {
            return
          }
          const dispatch = db.getDispatchContextById(dispatchId)
          if (!dispatch || closeReportedApproval(db, dispatch, approvalId, outcome, this.deps)) {
            dispatchIds.delete(dispatchId)
          }
        }
      }
      if (!outcome || dispatchIds.size === 0) {
        session.approvals.delete(approvalId)
      }
    }
    if (session.approvals.size === 0 && this.sessions.get(sessionId) === session) {
      session.stop()
      this.sessions.delete(sessionId)
    }
  }

  /** After a restart, picks up approvals reported open whose closing line never came. */
  async adopt(): Promise<void> {
    if (this.deps.signal.aborted) {
      return
    }
    const db = this.deps.getDb()
    const sessions = new Set<string>()
    for (const { approval, dispatch } of db ? recentOpenApprovalReports(db) : []) {
      if (this.deps.signal.aborted) {
        return
      }
      const { approvalId } = approval
      if (
        !db ||
        approvalId.startsWith(TERMINAL_APPROVAL_ID_PREFIX) ||
        db.getMessageById(approvalReportId(dispatch.id, approvalId, 'closed'))
      ) {
        continue
      }
      // The chat's live session, its `/clear` successor included; null once the Dispatch ended.
      const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
      if (custody === 'unverifiable') {
        continue
      }
      const sessionId = typeof custody === 'object' ? custody.sessionId : null
      if (!sessionId) {
        // The worker is gone, so nothing can answer it now.
        closeReportedApproval(
          db,
          dispatch,
          approvalId,
          { by: 'unknown', decision: null, reason: null, reasonDelivered: false },
          this.deps
        )
        continue
      }
      this.track(sessionId, approvalId, dispatch.id)
      sessions.add(sessionId)
    }
    await Promise.all([...sessions].map((sessionId) => this.check(sessionId)))
  }
}
