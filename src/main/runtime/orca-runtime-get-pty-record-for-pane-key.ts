// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPruneMobileSessionTabGroupLayout } from './orca-runtime-prune-mobile-session-tab-group-layout'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { detectAgentStatusFromTitle, isClaudeManagementTitle } from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'

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

  deliverPendingMessagesForHandle(handle: string, reservedTypes?: ReadonlySet<string>): void {
    this.orchestrationMailboxNotifications.deliverForHandle(handle, reservedTypes)
  }

  protected scheduleRestoredMessageRepoints(): void {
    let handles: string[]
    try {
      handles = this._orchestrationDb?.getUndeliveredUnreadMailboxHandles?.() ?? []
    } catch (error) {
      console.warn('[orchestration] failed to scan restored mailboxes', error)
      return
    }
    for (const handle of handles) {
      try {
        if (handle.startsWith('dispatch:')) {
          continue
        }
        if (handle.startsWith('run:')) {
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
