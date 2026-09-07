// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from './orca-runtime-prune-mobile-session-tab-group-layout'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { detectAgentStatusFromTitle, isClaudeManagementTitle } from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'
import { structuredWorkerIdentities } from './structured-worker-identity'
import { isSettledNativeOwner } from './orchestration/structured-session-pointer-delivery'
import type { StructuredPointerTarget } from './orchestration/structured-mailbox-pointer-delivery'
import {
  resolveTerminalIdentityFromProbes,
  type RuntimeTerminalIdentity
} from './terminal-identity-probe'

export class OrcaRuntimeWithGetPtyRecordForPaneKey extends OrcaRuntimeWithPruneMobileSessionTabGroupLayout {
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
      const ptyPane = parsePaneKey(pty.paneKey ?? '')
      if (pty.paneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
        if (pty.connected) {
          return pty
        }
        newestMatch = pty
      }
    }
    return leafPty ?? newestMatch
  }

  protected getPaneKeyForTerminalHandle(handle: string): string | null {
    const livePty = this.getLivePtyForHandle(handle)
    if (livePty?.pty.paneKey) {
      return livePty.pty.paneKey
    }
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      return null
    }
    if (!isTerminalLeafId(record.leafId)) {
      return null
    }
    return makePaneKey(record.tabId, record.leafId)
  }

  protected getWorktreeIdForTerminalHandle(handle: string): string | null {
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

  // Why: title is the tightest agent-presence signal, but a Claude management title is negative evidence for task activity.
  async isTerminalRunningAgent(
    handle: string,
    options?: { retryForegroundWrappers?: boolean }
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
      // Why: the cached foreground name can be an executable basename nothing recognizes
      // (macOS p_comm reports the native Claude installer as `2.1.258`), and treating that
      // as "no agent" silently downgrades the prompt to unframed chunks, which Claude's
      // composer truncates. A fresh process-table scan reads the real command line.
      if (agent === undefined && this.ptyController.confirmForegroundProcess) {
        foregroundProcess = await this.ptyController.confirmForegroundProcess(ptyId)
        agent = recognizeAgentProcess(foregroundProcess)?.agent
      }
      if (agent !== 'claude' && agent !== 'codex') {
        return false
      }
      if (
        !(await this.isTerminalRunningAgent(handle, {
          retryForegroundWrappers: false,
          foregroundProcess
        }))
      ) {
        return false
      }
      trackedPty.foregroundAgent = agent
      return true
    } catch {
      return false
    }
  }

  /**
   * The identity seam: whether this handle still names a live agent identity, in either lane.
   *
   * Read-only by construction — a handle and a boolean — so it can serve the CLI's sender
   * validation without `terminal.show`'s writable-looking pane payload.
   */
  resolveTerminalIdentity(handle: string): RuntimeTerminalIdentity {
    return resolveTerminalIdentityFromProbes(handle, {
      isLiveStructuredWorker: () =>
        Boolean(resolveStructuredWorkerAuthority(handle, this._orchestrationDb)),
      hasLivePty: () => Boolean(this.getLivePtyForHandle(handle)),
      assertLiveLeaf: () => {
        this.getLiveLeafForHandle(handle)
      }
    })
  }

  /**
   * A structured worker's own pane key, for callers that can only name the session.
   *
   * Resolved HERE rather than published: the pane key is a random identity credential — anyone
   * holding it can read and consume that worker's mailbox, and session ids are embedded in tab ids
   * — so it must never travel to a renderer to be echoed back.
   */
  getStructuredWorkerPaneKeyForSession(sessionId: string): string | null {
    const identity = structuredWorkerIdentities.getBySessionId(sessionId)
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

  /** Settlement drops anything parked for the session; nothing will ever redrive it again. */
  forgetStructuredSessionMail(sessionId: string): void {
    this.orchestrationStructuredMailboxPointerDelivery.forgetSession(sessionId)
  }

  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * All THREE address forms a structured session can own resolve here — its `dispatch:` address,
   * its `run:` mailbox when it coordinates, and its own bearer handle for peer mail outside a
   * dispatch. `run:` was the one that fell in a hole: the PTY lane declines because the owner is
   * structured, and this lane used to decline anything that was not `dispatch:`, so each half
   * believed the other owned it and a structured coordinator was never nudged.
   */
  protected resolveStructuredMailboxTarget(mailboxHandle: string): StructuredPointerTarget | null {
    if (mailboxHandle.startsWith('run:')) {
      return this.resolveStructuredCoordinatorMailboxTarget(mailboxHandle.slice('run:'.length))
    }
    if (!mailboxHandle.startsWith('dispatch:')) {
      return this.resolveStructuredWorkerDirectMailboxTarget(mailboxHandle)
    }
    const dispatchId = mailboxHandle.slice('dispatch:'.length)
    const assignee = this._orchestrationDb?.getDispatchContextById?.(dispatchId)?.assignee_handle
    if (!assignee) {
      return null
    }
    const identity = resolveStructuredWorkerAuthority(assignee, this._orchestrationDb)?.identity
    if (identity) {
      return { sessionId: identity.sessionId, dispatchId }
    }
    return this.resolveAdoptedStructuredMailboxTarget(assignee, dispatchId)
  }

  /**
   * A Run's own mailbox, when the coordinator holding it is a structured session.
   *
   * A structured coordinator does NOT block in `check --wait` the way a PTY one does — it is a
   * chat session, and its turn ends — so the waiter that used to preempt pointer delivery is not
   * there to cover for the missing nudge. Session-scoped: a coordinator's run mailbox has no
   * dispatch, and needs none, since the ledger bucket is all a dispatch id ever supplied.
   */
  protected resolveStructuredCoordinatorMailboxTarget(
    runId: string
  ): StructuredPointerTarget | null {
    const coordinator = this._orchestrationDb?.getRun?.(runId)?.coordinator_handle
    if (!coordinator) {
      return null
    }
    const identity = resolveStructuredWorkerAuthority(coordinator, this._orchestrationDb)?.identity
    return identity ? { sessionId: identity.sessionId, dispatchId: null } : null
  }

  /**
   * Direct peer mail, addressed to the worker's own handle rather than to a dispatch.
   *
   * Nothing else can serve it: the PTY lane refuses a structured handle outright, so without this
   * the send stores durably, reports success, and no lane ever nudges the worker — the sender sees
   * success and the peer waiting on a reply hangs.
   *
   * The worker's ACTIVE dispatch is preferred when it has one, so peer and coordinator nudges share
   * one operation-ledger budget and one set of retain rules. A worker BETWEEN dispatches is still
   * nudged, under a session-scoped budget: the mail is durable, the session is live, and a dispatch
   * says nothing about whether delivery is safe — the idle gate and the lease fence do that.
   */
  protected resolveStructuredWorkerDirectMailboxTarget(
    handle: string
  ): StructuredPointerTarget | null {
    const db = this._orchestrationDb
    // Answers null for anything that is not a live structured worker of THIS runtime, so `run:`
    // and PTY handles fall through to the PTY lane exactly as before.
    const identity = resolveStructuredWorkerAuthority(handle, db)?.identity
    if (!identity) {
      return null
    }
    const dispatchId = db?.findActiveDispatchForAssignee?.(handle, identity.paneKey)?.id ?? null
    return { sessionId: identity.sessionId, dispatchId }
  }

  /**
   * A PTY-born worker whose pane was since adopted by native chat.
   *
   * Its bytes cannot land — every runtime write path re-admits through the same gate — so the
   * pointer has to travel as a session turn instead. Only a SETTLED native owner qualifies: a
   * mid-handoff lease may become a TUI again, and redirecting there races the takeover.
   */
  protected resolveAdoptedStructuredMailboxTarget(
    assignee: string,
    dispatchId: string
  ): StructuredPointerTarget | null {
    let ptyId: string | null | undefined
    try {
      ptyId = this.getLiveLeafForHandle(assignee).leaf.ptyId
    } catch {
      return null
    }
    if (!ptyId) {
      return null
    }
    const admission = agentSessionPtyWriteGate.admit(ptyId)
    if (admission.admitted || !isSettledNativeOwner(admission.refusal)) {
      return null
    }
    return { sessionId: admission.refusal.sessionId, dispatchId, refusal: admission.refusal }
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
