import {
  TerminalIdentityRawInputs,
  TerminalIdentityReadContext
} from './terminal-identity-read-context'
import { OrcaRuntimeWithMailboxTerminalIdentity } from '../../orchestration/mailbox-terminal-identity'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { ResolvedWorktree } from '../../runtime-worktree-path-identity'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import type { RuntimeTerminalRead, RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import { getLatestPtyTitle } from '../../runtime-worktree-status-projection'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  ptyHoldsRecordedSurface,
  type PtySurfaceTopology
} from '../../pty-recorded-surface-topology'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'
import { readTerminalTail } from '../../terminal-tail-read'
import { structuredWorkerTerminalRefusal } from '../../structured-worker-terminal-refusal'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export abstract class OrcaRuntimeWithBuildPtyTerminalSummary extends OrcaRuntimeWithMailboxTerminalIdentity {
  protected abstract bindPtyIncarnationHandle(
    retained: PtyIncarnationHandleRecord,
    leaf: RuntimeLeafRecord
  ): void

  createTerminalIdentityRawInputs(): TerminalIdentityRawInputs {
    return new TerminalIdentityRawInputs(this.terminalIdentitySources())
  }

  createTerminalIdentityReadContext(
    inputs?: TerminalIdentityRawInputs
  ): TerminalIdentityReadContext {
    return new TerminalIdentityReadContext(this.terminalIdentitySources(), inputs)
  }

  protected ptySurfaceTopology(): PtySurfaceTopology {
    return {
      graphSequence: this.graphSequence,
      ptyIdHoldingPane: (tabId, leafId) => this.leaves.get(this.getLeafKey(tabId, leafId))?.ptyId
    }
  }

  protected buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(pty.worktreeId)

    const recorded = this.paneOfPty(pty)
    const pane = parsePaneKey(recorded.paneKey ?? '')
    const orphaned = !ptyHoldsRecordedSurface(pty.ptyId, recorded, this.ptySurfaceTopology())
    const processTitle = getLatestPtyTitle(this.getPtyDisplayRecord(pty))
    const title = this.getPtyManualTitle(pty, orphaned) ?? processTitle
    const paneTitle =
      orphaned || !recorded.tabId || !pane
        ? null
        : this.getSavedPaneTitle(pty.worktreeId, recorded.tabId, pane.leafId)
    // A live process awaiting its pane binding is not evidence of an orphan.
    if (
      orphaned &&
      (this.pendingPtyRegistrationIncarnations.has(pty.ptyId) ||
        this.terminalMutationLock.hasActiveSpawns(worktreeIdentityKey(pty.worktreeId)))
    ) {
      throw new Error('terminal_surface_ownership_unavailable')
    }
    return {
      handle: this.issuePtyHandle(pty),
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      orphaned,
      ...(orphaned && pane && pane.tabId === recorded.tabId && recorded.paneKey
        ? { recordedPaneKey: recorded.paneKey }
        : {}),
      worktreeId: pty.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: orphaned ? `pty:${pty.ptyId}` : recorded.tabId!,
      // SAFETY: A later binding read does not prove the cached pane was present.
      leafId: orphaned ? `pty:${pty.ptyId}` : pane!.leafId,
      title,
      ...(paneTitle ? { paneTitle } : {}),
      connected: pty.connected,
      writable: pty.connected,
      lastOutputAt: pty.lastOutputAt,
      preview: pty.preview,
      ...(pty.lastExitCause ? { exitCause: pty.lastExitCause } : {}),
      ...this.terminalExecutionHostField(pty.ptyId, pty.worktreeId),
      ...this.resolvePaneAgentIdentityField(
        pty.launchAgent ?? pty.launchCommandAgent,
        pty.foregroundAgent,
        processTitle,
        recorded.paneKey
      )
    }
  }

  /** The terminal's manual name: its saved tab's, or the rename's while no saved tab holds it. */
  protected getPtyManualTitle(pty: RuntimePtyWorktreeRecord, orphaned: boolean): string | null {
    const tab = orphaned
      ? undefined
      : this.getWorkspaceSessionForWorktree(pty.worktreeId)?.tabsByWorktree[pty.worktreeId]?.find(
          (candidate) => candidate.id === this.paneOfPty(pty).tabId
        )
    return tab ? tab.customTitle?.trim() || null : (pty.manualTitle ?? null)
  }

  protected getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.assertGraphReady()
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      // Structured workers are live sessions without terminals; read paths answer before this refusal, and stale-handle errors would send callers hunting nonexistent remints.
      throw structuredWorkerTerminalRefusal(handle, this._orchestrationDb)
    }
    if (record.rendererGraphEpoch !== this.rendererGraphEpoch) {
      throw new Error('terminal_handle_stale')
    }

    const leaf = this.leaves.get(this.getLeafKey(record.tabId, record.leafId))
    if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
      throw new Error('terminal_handle_stale')
    }
    return { record, leaf }
  }

  /** The terminal a handle names: its runtime PTY, the PTY its retained handle was issued for, or the PTY its window pane shows. */
  protected getTerminalPtyForHandle(handle: string): { pty: RuntimePtyWorktreeRecord } {
    const pty =
      this.getLivePtyForHandle(handle)?.pty ??
      this.getRetainedHandlePty(handle) ??
      this.ptysById.get(this.getLiveLeafForHandle(handle).leaf.ptyId ?? '')
    if (!pty) {
      throw new Error('terminal_handle_stale')
    }
    return { pty }
  }

  /** A pane-issued handle outlives the graph (a reload) while its PTY keeps the incarnation it was issued for. */
  protected getRetainedHandlePty(handle: string): RuntimePtyWorktreeRecord | undefined {
    const pty = this.getPaneAliasPty(handle)
    // Once no pane shows it, the alias only answers exit waits (getExitWaitPtyForHandle).
    return pty && this.getLeavesForPty(pty.ptyId).length > 0 ? pty : undefined
  }

  /** An exit wait may name a closed pane's process: the owner's record answers until it is pruned or replaced. */
  protected getExitWaitPtyForHandle(handle: string): { pty: RuntimePtyWorktreeRecord } {
    try {
      return this.getTerminalPtyForHandle(handle)
    } catch (error) {
      const pty = this.getPaneAliasPty(handle)
      if (!pty) {
        throw error
      }
      return { pty }
    }
  }

  private getPaneAliasPty(handle: string): RuntimePtyWorktreeRecord | undefined {
    const ptyId = this.terminalIdentity.firstIncarnationPtyId(handle)
    const retained = ptyId === undefined ? undefined : this.handleByPtyIncarnation.get(ptyId)
    const pty = ptyId ? this.ptysById.get(ptyId) : undefined
    return retained?.incarnationId && pty?.incarnationId === retained.incarnationId
      ? pty
      : undefined
  }

  /** Whether a handle names a terminal, including one a graph reload cleared the record of. */
  protected hasMailboxTerminalHandle(handle: string): boolean {
    const named = this.getLivePtyForHandle(handle)?.pty ?? this.getRetainedHandlePty(handle)
    return this.handles.has(handle) || named !== undefined
  }

  protected getLivePtyForHandle(
    handle: string,
    context?: TerminalIdentityReadContext
  ): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    let record = this.handles.get(handle)
    if (!record) {
      const ptyId = context
        ? context.reversePtyIds(handle)[0]
        : [...this.handleByPtyId.entries()].find(([, mappedHandle]) => mappedHandle === handle)?.[0]
      const pty = ptyId ? this.ptysById.get(ptyId) : null
      if (pty) {
        // Why: graph reload clears renderer handle records, but runtime-owned PTY handles remain the caller's control identity.
        this.issuePtyHandle(pty, context)
        record = this.handles.get(handle)
      }
    }
    if (
      !record ||
      record.runtimeId !== this.runtimeId ||
      !(record.tabId.startsWith('pty:') || this.mainPaneOwnHandle(handle, record, context))
    ) {
      return null
    }
    if (!record.ptyId) {
      return null
    }
    const pty = this.ptysById.get(record.ptyId)
    if (!pty || pty.ptyId !== record.ptyId) {
      return null
    }
    // Why: renderer adoption can race with CLI reads; keep ptyId → handle populated so summaries don't mint a second handle for the same terminal.
    this.setPtyHandle(record.ptyId, handle)
    context?.changedReverseBinding(record.ptyId)
    return { record, pty }
  }

  /** Main-owned panes adopt the terminal's original handle; own-handle checks fence epochs because replacement incarnations drop that handle. */
  private mainPaneOwnHandle(
    handle: string,
    record: TerminalHandleRecord,
    context?: TerminalIdentityReadContext
  ): boolean {
    if (
      !ORCA_LAYOUT_OWNER_IS_MAIN ||
      !record.ptyId ||
      !isTerminalLeafId(record.leafId) ||
      !isValidTerminalTabId(record.tabId) ||
      this.handleByPtyId.get(record.ptyId) !== handle
    ) {
      return false
    }
    const pty = this.ptysById.get(record.ptyId)
    return (
      (context && pty ? context.paneOf(pty) : this.paneOfPty(pty)).paneKey ===
      makePaneKey(record.tabId, record.leafId)
    )
  }

  protected assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    if (this.getTerminalPtyForHandle(handle).pty.ptyId !== expectedPtyId) {
      throw new Error('terminal_handle_stale')
    }
  }

  protected readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts: { cursor?: number; limit?: number } = {}
  ): RuntimeTerminalRead {
    return readTerminalTail({
      handle,
      status: pty.connected ? 'running' : pty.lastExitCode !== null ? 'exited' : 'unknown',
      previewLines: pty.tailBuffer,
      completedLines: pty.tailTranscriptBuffer,
      partialLine: pty.tailPartialLine,
      completedLineCount: pty.tailLinesTotal,
      bufferTruncated: pty.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
  }
  getTerminalHandleForPaneKey(
    paneKey: string,
    context?: TerminalIdentityReadContext
  ): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : undefined
    if (leaf?.ptyId && leaf.connected) {
      return this.issueHandle(leaf, context)
    }
    const panePty = this.getPtyRecordForPaneKey(paneKey, context)
    if (panePty?.connected) {
      return this.issuePtyHandle(panePty, context)
    }
    if (leaf?.ptyId) {
      return this.issueHandle(leaf, context)
    }
    return panePty ? this.issuePtyHandle(panePty, context) : null
  }
}
