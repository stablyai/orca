import type { RuntimeTerminalAgentPresenceOptions } from '../runtime-terminal-agent-presence'
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle
} from '../../../shared/agent-detection'
import {
  GENERIC_PROCESS_NAME_AGENTS,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import {
  resolveStructuredWorkerAuthority,
  resolveStructuredWorkerIdentityForSession
} from '../structured-worker-authority'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import {
  chatDispatchMailTarget,
  handleLessCoordinatorSessionId,
  structuredSessionAddressTarget,
  structuredSessionMailTarget,
  structuredSessionIdleEdgeMailboxes
} from './structured-session-mail-target'
import { exitedChatDispatchesForSession } from './chat-assignee'
import { OPERATOR_CLOSE_EXIT_CAUSE } from '../../../shared/terminal-exit-cause'
import { resolveTerminalIdentityFromProbes } from '../terminal-identity-probe'

export abstract class OrcaRuntimeWithGetPtyRecordForPaneKey extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
  protected getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null {
    const parsed = parsePaneKey(paneKey)
    let leafPty: RuntimePtyWorktreeRecord | null = null
    if (parsed) {
      const leaf = this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId))
      const pty = leaf?.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
      if (pty?.connected) {
        return pty
      }
      leafPty = pty ?? null
      for (const candidate of this.leaves.values()) {
        if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
          continue
        }
        const remintedPty = this.ptysById.get(candidate.ptyId)
        if (remintedPty?.connected) {
          return remintedPty
        }
        leafPty ??= remintedPty ?? null
      }
    }
    let newestMatch: RuntimePtyWorktreeRecord | null = null
    for (const pty of this.ptysById.values()) {
      const recordedPaneKey = this.paneOfPty(pty).paneKey
      const ptyPane = parsePaneKey(recordedPaneKey ?? '')
      if (recordedPaneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
        if (pty.connected) {
          return pty
        }
        newestMatch = pty
      }
    }
    return leafPty ?? newestMatch
  }

  protected getPaneKeyForTerminalHandle(handle: string): string | null {
    const livePaneKey = this.paneOfPty(this.getLivePtyForHandle(handle)?.pty).paneKey
    if (livePaneKey) {
      return livePaneKey
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId || !isTerminalLeafId(record.leafId)) {
      return null
    }
    return makePaneKey(record.tabId, record.leafId)
  }

  getTerminalWorktreeIdForHandle(handle: string): string | null {
    const livePty = this.getLivePtyForHandle(handle)
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
      const livePty = this.getLivePtyForHandle(handle)
      const leaf = livePty ? null : this.getLiveLeafForHandle(handle).leaf
      const ptyId = livePty?.pty.ptyId ?? leaf?.ptyId ?? null
      const trackedPty = livePty?.pty ?? (ptyId ? this.ptysById.get(ptyId) : null)
      if (!ptyId || !trackedPty || !this.ptyController) {
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

  /** Pane keys authorize mailbox access; resolve locally and never expose them through renderer-embedded session ids. */
  getStructuredWorkerPaneKeyForSession(sessionId: string): string | null {
    const identity = resolveStructuredWorkerIdentityForSession(sessionId, this._orchestrationDb)
    return identity && resolveStructuredWorkerAuthority(identity.handle, this._orchestrationDb)
      ? identity.paneKey
      : null
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
    this.removeWindowlessAgentSessionTab(sessionId)
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

  /** Resolve every structured-owned mailbox here; declining Run or direct mail would leave both delivery lanes refusing it. */
  protected resolveStructuredMailboxTarget(mailboxHandle: string): StructuredPointerTarget | null {
    if (mailboxHandle.startsWith('run:')) {
      return this.resolveStructuredCoordinatorMailboxTarget(mailboxHandle.slice('run:'.length))
    }
    const addressed = structuredSessionAddressTarget(mailboxHandle, this._orchestrationDb)
    if (addressed !== undefined) {
      return addressed
    }
    if (!mailboxHandle.startsWith('dispatch:')) {
      return this.resolveStructuredWorkerDirectMailboxTarget(mailboxHandle)
    }
    const dispatchId = mailboxHandle.slice('dispatch:'.length)
    const dispatch = this._orchestrationDb?.getDispatchContextById?.(dispatchId)
    const assignee = dispatch?.assignee_handle
    if (!assignee) {
      return null
    }
    const chat = chatDispatchMailTarget(dispatch, this._orchestrationDb)
    if (chat !== undefined) {
      return chat
    }
    const sessionId = this.liveStructuredWorkerSessionId(assignee)
    return sessionId ? { sessionId, dispatchId } : null
  }

  /** Structured coordinators need Run nudges after turns end; no blocking check waiter or Dispatch is required. */
  protected resolveStructuredCoordinatorMailboxTarget(
    runId: string
  ): StructuredPointerTarget | null {
    const run = this._orchestrationDb?.getRun?.(runId)
    const sessionId = run ? handleLessCoordinatorSessionId(run) : null
    if (sessionId) {
      return structuredSessionMailTarget(sessionId, this._orchestrationDb)
    }
    const coordinator = run?.coordinator_handle
    if (!coordinator) {
      return null
    }
    const workerSessionId = this.liveStructuredWorkerSessionId(coordinator)
    return workerSessionId ? { sessionId: workerSessionId, dispatchId: null } : null
  }

  /** Route direct worker mail through its active Dispatch or a session-scoped ledger between Dispatches; downstream idle/lease gates decide safety. */
  protected resolveStructuredWorkerDirectMailboxTarget(
    handle: string
  ): StructuredPointerTarget | null {
    const db = this._orchestrationDb
    // Only this runtime's held structured workers resolve here; other owners remain for their own lane.
    const authority = resolveStructuredWorkerAuthority(handle, db)
    if (!authority) {
      return null
    }
    const dispatchId =
      db?.findActiveDispatchForAssignee?.(handle, authority.identity.paneKey)?.id ?? null
    return { sessionId: authority.running.sessionId, dispatchId }
  }

  /** The session running a structured worker of this runtime: its `/clear` successor, if any. */
  private liveStructuredWorkerSessionId(handle: string): string | null {
    return (
      resolveStructuredWorkerAuthority(handle, this._orchestrationDb)?.running.sessionId ?? null
    )
  }

  protected scheduleRestoredMessageRepoints(): void {
    let handles: Set<string>
    try {
      const db = this._orchestrationDb
      // Pointer-phase rows are excluded from the undelivered scan, so they need their own.
      handles = new Set([
        ...(db?.getUndeliveredUnreadMailboxHandles?.() ?? []),
        ...(db?.getPendingMailboxPointerHandles?.() ?? [])
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

  protected deliverPendingMessagesForLeaf(leaf: RuntimeLeafRecord): void {
    this.orchestrationMailboxNotifications.deliverForLeaf(leaf)
  }
}
