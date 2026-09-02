// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetPtyRecordForPaneKey } from './orca-runtime-get-pty-record-for-pane-key'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeTerminalRead, RuntimeTerminalSummary } from '../../shared/runtime-types'
import { getLatestPtyTitle } from './runtime-worktree-status-projection'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import { readTerminalTail } from './terminal-tail-read'
import { randomUUID } from 'node:crypto'

export class OrcaRuntimeWithBuildPtyTerminalSummary extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  protected buildPtyTerminalSummary(
    pty: RuntimePtyWorktreeRecord,
    worktreesById: Map<string, ResolvedWorktree>
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(pty.worktreeId)

    const title = getLatestPtyTitle(pty)
    const pane = parsePaneKey(pty.paneKey ?? '')
    const orphaned = !pty.tabId || !pane || pane.tabId !== pty.tabId
    return {
      handle: this.issuePtyHandle(pty),
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      orphaned,
      worktreeId: pty.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: orphaned ? `pty:${pty.ptyId}` : pty.tabId!,
      leafId: orphaned ? `pty:${pty.ptyId}` : pane.leafId,
      title,
      connected: pty.connected,
      writable: pty.connected,
      lastOutputAt: pty.lastOutputAt,
      preview: pty.preview,
      ...(pty.lastExitCause ? { exitCause: pty.lastExitCause } : {}),
      ...this.terminalExecutionHostField(pty.ptyId, pty.worktreeId),
      ...this.resolvePaneAgentIdentityField(
        pty.launchAgent,
        pty.foregroundAgent,
        title,
        pty.paneKey ?? null
      )
    }
  }

  protected getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  } {
    this.assertGraphReady()
    const record = this.handles.get(handle)
    if (!record || record.runtimeId !== this.runtimeId) {
      throw new Error('terminal_handle_stale')
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
    if (!record || record.runtimeId !== this.runtimeId || !record.tabId.startsWith('pty:')) {
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
    if (leaf.ptyId && incarnationId) {
      this.handleByPtyIncarnation.set(leaf.ptyId, { handle, incarnationId, leafKey })
    }
    return handle
  }
}
