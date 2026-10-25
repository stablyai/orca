import { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../../orchestration/terminal-pane-mail-routing'
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
import { randomUUID } from 'node:crypto'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export abstract class OrcaRuntimeWithBuildPtyTerminalSummary extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  protected abstract bindPtyIncarnationHandle(
    retained: PtyIncarnationHandleRecord,
    leaf: RuntimeLeafRecord
  ): void

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

  protected getLivePtyForHandle(handle: string): {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null {
    let record = this.handles.get(handle)
    if (!record) {
      const ptyId = [...this.handleByPtyId.entries()].find(
        ([, mappedHandle]) => mappedHandle === handle
      )?.[0]
      const pty = ptyId ? this.ptysById.get(ptyId) : null
      if (pty) {
        // Why: graph reload clears renderer handle records, but runtime-owned PTY handles remain the caller's control identity.
        this.issuePtyHandle(pty)
        record = this.handles.get(handle)
      }
    }
    if (
      !record ||
      record.runtimeId !== this.runtimeId ||
      !(record.tabId.startsWith('pty:') || this.mainPaneOwnHandle(handle, record))
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
    this.handleByPtyId.set(record.ptyId, handle)
    return { record, pty }
  }

  /** Main-owned panes adopt the terminal's original handle; own-handle checks fence epochs because replacement incarnations drop that handle. */
  private mainPaneOwnHandle(handle: string, record: TerminalHandleRecord): boolean {
    if (
      !ORCA_LAYOUT_OWNER_IS_MAIN ||
      !record.ptyId ||
      !isTerminalLeafId(record.leafId) ||
      !isValidTerminalTabId(record.tabId) ||
      this.handleByPtyId.get(record.ptyId) !== handle
    ) {
      return false
    }
    return (
      this.paneOfPty(this.ptysById.get(record.ptyId)).paneKey ===
      makePaneKey(record.tabId, record.leafId)
    )
  }

  protected assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void {
    const runtimePty = this.getLivePtyForHandle(handle)
    if (runtimePty) {
      if (runtimePty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_handle_stale')
      }
      return
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    if (leaf.ptyId !== expectedPtyId) {
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

  protected issueHandle(leaf: RuntimeLeafRecord): string {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    const existingHandle = this.handleByLeafKey.get(leafKey)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.rendererGraphEpoch === this.rendererGraphEpoch &&
        existingRecord.ptyId === leaf.ptyId &&
        existingRecord.ptyGeneration === leaf.ptyGeneration
      ) {
        return existingHandle
      }
    }

    const preAllocatedHandle = this.adoptPreAllocatedHandle(leaf)
    if (preAllocatedHandle) {
      return preAllocatedHandle
    }
    const incarnationId = leaf.ptyId ? (this.ptysById.get(leaf.ptyId)?.incarnationId ?? null) : null
    const retained = leaf.ptyId ? this.handleByPtyIncarnation.get(leaf.ptyId) : undefined
    if (retained && leaf.ptyId && retained.incarnationId !== incarnationId) {
      this.invalidatePtyIncarnationHandle(leaf.ptyId)
    } else if (retained) {
      this.bindPtyIncarnationHandle(retained, leaf)
      return retained.handle
    }
    const handle = `term_${randomUUID()}`
    this.syntheticTerminalHandles.add(handle)
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, handle)
    if (leaf.ptyId) {
      this.handleByPtyIncarnation.set(leaf.ptyId, { handle, incarnationId, leafKey })
    }
    return handle
  }
}
