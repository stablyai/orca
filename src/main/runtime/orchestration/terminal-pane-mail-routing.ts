import {
  ptyRecordForPaneKey,
  type TerminalIdentityReadContext
} from '../terminal/query/terminal-identity-read-context'
import type { RuntimeTerminalAgentPresenceOptions } from '../runtime-terminal-agent-presence'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle
} from '../../../shared/agent-detection'
import {
  GENERIC_PROCESS_NAME_AGENTS,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { resolveStructuredWorkerAuthority } from '../structured-worker-authority'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import type { OrchestrationDb } from './db'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import {
  structuredMailboxCustody,
  structuredSessionIdleEdgeMailboxes,
  type StructuredMailboxCustody
} from './structured-session-mail-target'
import { exitedChatDispatchesForSession } from './chat-assignee'
import { OPERATOR_CLOSE_EXIT_CAUSE } from '../../../shared/terminal-exit-cause'
import { resolveTerminalIdentityFromProbes } from '../terminal-identity-probe'

export abstract class OrcaRuntimeWithGetPtyRecordForPaneKey extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  protected terminalIdentitySources = () => ({
    handles: this.handles,
    sshTerminals: this.orchestrationCompatibilitySshTerminals,
    reverse: this.handleByPtyId,
    leaves: this.leaves,
    ptys: this.ptysById,
    capturePaneOf: () => this.captureTerminalPaneReader()
  })

  protected getPtyRecordForPaneKey(
    paneKey: string,
    context?: TerminalIdentityReadContext
  ): RuntimePtyWorktreeRecord | null {
    return ptyRecordForPaneKey(
      paneKey,
      {
        leaves: this.leaves,
        ptys: this.ptysById,
        leafKey: (tab, leaf) => this.getLeafKey(tab, leaf),
        capturePaneOf: () => this.captureTerminalPaneReader()
      },
      context
    )
  }

  protected getPaneKeyForTerminalHandle(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null {
    const pty = this.getLivePtyForHandle(handle, context)?.pty
    const livePaneKey = (context && pty ? context.paneOf(pty) : this.paneOfPty(pty)).paneKey
    if (livePaneKey) {
      return livePaneKey
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId || !isTerminalLeafId(record.leafId)) {
      return null
    }
    return makePaneKey(record.tabId, record.leafId)
  }

  getTerminalWorktreeIdForHandle(
    handle: string,
    context?: TerminalIdentityReadContext
  ): string | null {
    const livePty = this.getLivePtyForHandle(handle, context)
    if (livePty?.pty.worktreeId) {
      return livePty.pty.worktreeId
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      return null
    }
    return record.worktreeId
  }

  protected setPtyManagementTitleFromObservedTitle(
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ): void {
    const trimmed = title?.trim()
    if (!trimmed) {
      return
    }
    if (isClaudeManagementTitle(trimmed)) {
      pty.managementTitle = trimmed
      pty.managementTitleAt = observedAt
      return
    }
    if (
      detectAgentStatusFromTitle(trimmed) !== null &&
      observedAt >= (pty.managementTitleAt ?? -1)
    ) {
      pty.managementTitle = null
      pty.managementTitleAt = null
    }
  }

  protected nextTitleObservationSequence(): number {
    this.titleObservationSequence += 1
    return this.titleObservationSequence
  }

  // Agent titles prove presence, but Claude management titles do not imply task activity.
  async isTerminalRunningAgent(
    handle: string,
    options?: RuntimeTerminalAgentPresenceOptions
  ): Promise<boolean> {
    return this.terminalAgentPresence.isRunning(handle, options)
  }

  async isTerminalRunningSettledPromptAgent(handle: string): Promise<boolean> {
    try {
      const { pty: trackedPty } = this.getTerminalPtyForHandle(handle)
      const { ptyId } = trackedPty
      if (!this.ptyController) {
        return false
      }
      let foregroundProcess = await this.ptyController.getForegroundProcess(ptyId)
      let agent = recognizeAgentProcess(foregroundProcess)?.agent
      // Confirm unfamiliar foreground names (macOS Claude p_comm can be 2.1.258) before downgrading atomic paste to truncating unframed chunks.
      if (agent === undefined && this.ptyController.confirmForegroundProcess) {
        foregroundProcess = await this.ptyController.confirmForegroundProcess(ptyId)
        agent = recognizeAgentProcess(foregroundProcess)?.agent
      }
      // Why every agent: unframed keystrokes can open Pi's `#` completion or answer a trust menu; Dispatch already frames them all.
      // A generic process name alone could be an ordinary tool, so those agents need title or hook evidence.
      const proof = agent && GENERIC_PROCESS_NAME_AGENTS.has(agent) ? null : foregroundProcess
      const presence = { retryForegroundWrappers: false, foregroundProcess: proof }
      if (agent === undefined || !(await this.isTerminalRunningAgent(handle, presence))) {
        return false
      }
      trackedPty.foregroundAgent = agent
      return true
    } catch {
      return false
    }
  }

  /** Read-only live-agent identity in either lane, without terminal.show's writable-looking pane payload. */
  resolveTerminalIdentity(handle: string) {
    return resolveTerminalIdentityFromProbes(handle, {
      isLiveStructuredWorker: () =>
        Boolean(resolveStructuredWorkerAuthority(handle, this._orchestrationDb)),
      hasLivePty: () => Boolean(this.getLivePtyForHandle(handle)),
      assertLiveLeaf: () => {
        this.getLiveLeafForHandle(handle)
      }
    })
  }

  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.orchestrationMailboxNotifications.deliverForHandle(handle, reservedTypes)
  }

  /** The structured idle edge: any journal movement is a chance to redrive parked mail. */
  notifyStructuredSessionJournalActivity(sessionId: string): void {
    this.orchestrationStructuredMailboxPointerDelivery.onJournalActivity(sessionId)
  }

  /** Retry parked mail on working/idle edges; at idle re-derive owned mailboxes for workers and chats. */
  onStructuredSessionStatusForMail(summary: {
    sessionId: string
    status: 'working' | 'attention' | 'idle' | null
  }): void {
    if (summary.status === 'attention') {
      return
    }
    // Log failures without blocking the later first-turn workspace rename.
    try {
      // A working edge can follow a human answer, unblocking parked mail too.
      this.notifyStructuredSessionJournalActivity(summary.sessionId)
      if (summary.status === 'working') {
        return
      }
      const openDb = () => this.getExistingOrchestrationDb()
      const deliver = (mailbox: string) => this.deliverPendingMessagesForHandle(mailbox)
      structuredSessionIdleEdgeMailboxes(summary.sessionId, openDb).forEach(deliver)
    } catch (error) {
      console.warn('[orchestration] structured session mail redrive failed', {
        sessionId: summary.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Settle ended chat Dispatches on tab hide; /clear successors retain their work. */
  onStructuredSessionTabHidden(sessionId: string): void {
    try {
      const db = this.getExistingOrchestrationDb()
      for (const dispatch of db ? exitedChatDispatchesForSession(sessionId, db) : []) {
        this.failActiveDispatchOnExit(dispatch.assignee_handle, null, 0, OPERATOR_CLOSE_EXIT_CAUSE)
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
   *  longer owes. Visible cleanup only: it never holds up the action that called it. */
  withdrawStaleChatMail(): void {
    this.orchestrationStructuredMailboxPointerDelivery.withdrawStale()
  }

  /** Asked as a chat's queue hands over an agent's card; opening the database lets a restart's first
   *  handover decide. */
  structuredChatMailOwed(sessionId: string, from: AgentMessageSource): QueuedMessageOwed {
    let db: OrchestrationDb | null
    try {
      db = this.getExistingOrchestrationDb()
    } catch {
      return 'unavailable'
    }
    return this.orchestrationStructuredMailboxPointerDelivery.owedAtHandover(sessionId, from, db)
  }

  /** Resolve every structured-owned mailbox here; declining Run or direct mail would leave both delivery lanes refusing it. */
  protected resolveStructuredMailboxTarget(mailboxHandle: string): StructuredPointerTarget | null {
    const custody = this.structuredMailboxCustody(mailboxHandle)
    return typeof custody === 'object' ? custody : null
  }

  /** Who holds a mailbox, from durable facts: the chat its mail reaches, someone else, or unverifiable now. */
  protected structuredMailboxCustody(mailboxHandle: string): StructuredMailboxCustody {
    return structuredMailboxCustody(mailboxHandle, this._orchestrationDb)
  }

  protected scheduleRestoredMessageRepoints(): void {
    let handles: Set<string>
    try {
      const db = this._orchestrationDb
      // Pointer-phase rows are excluded from the undelivered scan, so they need their own.
      handles = new Set([
        ...(db?.getUndeliveredUnreadMailboxHandles?.() ?? []),
        ...(db?.getPendingMailboxPointerHandles?.() ?? []),
        // Delivered mail a chat still holds: what became of it is read on this pass.
        ...(db?.getStructuredMailSendMailboxes?.() ?? [])
      ])
    } catch (error) {
      console.warn('[orchestration] failed to scan restored mailboxes', error)
      return
    }
    for (const handle of handles) {
      try {
        if (handle.startsWith('run:') || handle.startsWith('dispatch:')) {
          this.mailPointerRepointScheduler.schedule(handle)
          continue
        }
        const routed = this.orchestrationMailboxOwner.routeDetachedDirectMessages(handle)
        for (const mailbox of routed.mailboxes) {
          this.mailPointerRepointScheduler.schedule(mailbox.mailboxHandle)
        }
        if (!routed.hasMore) {
          this.mailPointerRepointScheduler.schedule(handle)
        }
      } catch (error) {
        console.warn(`[orchestration] failed to restore mailbox ${handle}`, error)
        this.mailPointerRepointScheduler.schedule(handle)
      }
    }
  }

  protected repointPendingMessagesForHandle(handle: string): void {
    try {
      this.deliverPendingMessagesForHandle(handle)
    } catch {
      // The unref'd repair can outlive a test/runtime-owned database during shutdown.
    }
  }
}
