import { OrcaRuntimeWithGetPtyRecordForPaneKey } from './terminal-pane-mail-routing'
import type { OrchestrationDb } from '../../db/orchestration-db'
import {
  orchestrationMailNotice,
  type AgentMessageSource
} from '../../../../../shared/agent-session/journal/agent-session-message-source'
import type { QueuedMessageOwed } from '../../../../native-chat/agent-session-journal/queued-messages/queued-message-consume-error'
import { structuredSessionIdleEdgeMailboxes } from './structured-session-mail-target'
import { closedChatWorkersForSession } from '../../workers/lifecycle/chat-assignee'
import { OPERATOR_CLOSE_EXIT_CAUSE } from '../../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import { observeChatWorkerWorking } from '../../workers/turn-stops/chat-worker-turn-stops'

/** Mail for structured chat sessions: idle-edge redrives, closed chats, and what a chat is still owed. */
export abstract class OrcaRuntimeWithStructuredSessionMail extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  /** The structured idle edge: any journal movement is a chance to redrive parked mail. */
  notifyStructuredSessionJournalActivity(sessionId: string): void {
    this.orchestrationStructuredMailboxPointerDelivery.onJournalActivity(sessionId)
  }

  /** Retry parked mail on working/idle edges; at idle re-derive owned mailboxes for workers and chats. */
  onStructuredSessionStatusForMail(summary: {
    sessionId: string
    status: 'working' | 'attention' | 'idle' | null
  }): void {
    // A repeat (a streamed revision republishes the same status) is nothing new to mail; what the
    // journal changes, the parked mail's own watch hears.
    const delivery = this.orchestrationStructuredMailboxPointerDelivery
    if (
      !delivery.statusChanged(summary.sessionId, summary.status) ||
      summary.status === 'attention'
    ) {
      return
    }
    // Log failures without blocking the later first-turn workspace rename.
    try {
      if (summary.status === 'working') {
        observeChatWorkerWorking(summary.sessionId, this.workerTurnStopReportDeps)
        // A working edge can follow a human answer, unblocking parked mail too.
        this.notifyStructuredSessionJournalActivity(summary.sessionId)
        return
      }
      this.redriveStructuredSessionMail(summary.sessionId)
    } catch (error) {
      console.warn('[orchestration] structured session mail redrive failed', {
        sessionId: summary.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** A chat's idle edge for its mail: parked mail retried, and the mailboxes it owns re-derived. */
  redriveStructuredSessionMail(sessionId: string): void {
    this.notifyStructuredSessionJournalActivity(sessionId)
    const openDb = () => this.getExistingOrchestrationDb()
    const deliver = (mailbox: string) => this.deliverPendingMessagesForHandle(mailbox)
    structuredSessionIdleEdgeMailboxes(sessionId, openDb).forEach(deliver)
  }

  /** A closed chat ends its workers' Dispatches as a closed terminal does; /clear successors retain their work. */
  onStructuredSessionTabHidden(sessionId: string): void {
    try {
      const db = this.getExistingOrchestrationDb()
      for (const worker of db ? closedChatWorkersForSession(sessionId, db) : []) {
        this.failActiveDispatchOnExit(worker.handle, worker.paneKey, OPERATOR_CLOSE_EXIT_CAUSE)
      }
    } catch (error) {
      console.warn('[orchestration] settling a closed chat worker failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Settlement drops anything parked for the session; nothing will ever redrive it again. */
  forgetStructuredSessionMail(sessionId: string): void {
    this.orchestrationStructuredMailboxPointerDelivery.forgetSession(sessionId)
  }

  /** After a check, move, takeover or reset, delete the cards that would hand a chat mail it no
   *  longer owes. Visible cleanup only: it never holds up the action that called it. `mailboxes`:
   *  only those the action touched; without it, every mailbox (a reset, a store becoming readable). */
  withdrawStaleChatMail(mailboxes?: Iterable<string>): void {
    this.publishSleepingMail(mailboxes ? { mailboxes } : undefined)
    this.orchestrationStructuredMailboxPointerDelivery.withdrawStale(mailboxes)
  }

  settleConsumedTerminalMail(
    mailboxes: readonly string[],
    reservationPtys: readonly string[] = []
  ): void {
    this.publishSleepingMail({ mailboxes })
    try {
      const ptys = new Set(reservationPtys)
      for (const mailbox of mailboxes) {
        const terminal = this.orchestrationMailboxDeliveryTarget.resolveTerminal(mailbox)
        if (terminal) {
          ptys.add(terminal.ptyId)
        }
      }
      for (const ptyId of ptys) {
        this.orchestrationMailboxPointerDelivery.reconcileUncertainMail(ptyId)
        this.armDeliveryRecheck(ptyId, { settled: true })
      }
    } catch {
      // A consuming check must not fail because terminal cleanup is unavailable.
    }
  }

  /** Read current mailbox custody without settling a card or its reservation. */
  structuredChatMailOwed(
    sessionId: string,
    from: AgentMessageSource,
    claimedDeliveryId?: string
  ): QueuedMessageOwed {
    if (!orchestrationMailNotice(from)) {
      return 'owed'
    }
    let db: OrchestrationDb | null
    try {
      db = this.getExistingOrchestrationDb()
    } catch {
      return 'unavailable'
    }
    return this.orchestrationStructuredMailboxPointerDelivery.owedNow(
      sessionId,
      from,
      db,
      claimedDeliveryId
    )
  }
}
