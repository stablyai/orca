import type { TerminalIdentityReadContext } from '../query/terminal-identity-read-context'
import { OrcaRuntimeWithBuildPtyTerminalSummary } from '../query/pty-terminal-summary'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import { randomUUID } from 'node:crypto'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export abstract class OrcaRuntimeWithBindPtyIncarnationHandle extends OrcaRuntimeWithBuildPtyTerminalSummary {
  protected abstract getLeafKey(tabId: string, leafId: string): string

  protected bindPtyIncarnationHandle(
    retained: PtyIncarnationHandleRecord,
    leaf: RuntimeLeafRecord
  ): void {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    if (retained.leafKey !== leafKey) {
      if (this.handleByLeafKey.get(retained.leafKey) === retained.handle) {
        this.terminalIdentity.unbindLeaf(retained.leafKey)
      }
      this.terminalIdentity.setIncarnationLeaf(retained, leafKey)
    }
    this.terminalIdentity.setHandle(retained.handle, {
      handle: retained.handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.terminalIdentity.bindLeaf(leafKey, retained.handle)
  }

  protected invalidatePtyIncarnationHandle(ptyId: string): void {
    const retained = this.handleByPtyIncarnation.get(ptyId)
    if (!retained) {
      return
    }
    this.terminalIdentity.removeIncarnation(ptyId)
    if (this.handleByLeafKey.get(retained.leafKey) === retained.handle) {
      this.terminalIdentity.unbindLeaf(retained.leafKey)
    }
    this.terminalIdentity.removeHandle(retained.handle)
    this.terminalIdentity.removeSynthetic(retained.handle)
  }

  protected clearPtyIncarnationHandles(): void {
    for (const retained of this.handleByPtyIncarnation.values()) {
      this.terminalIdentity.removeSynthetic(retained.handle)
    }
    this.terminalIdentity.clearIncarnations()
  }

  protected reconcilePtyIncarnationHandles(): void {
    for (const [ptyId, retained] of this.handleByPtyIncarnation) {
      const pty = this.ptysById.get(ptyId)
      const leaves = this.getLeavesForPty(ptyId)
      // Learning a previously unknown incarnation fences the handle; only known-to-different means replacement.
      const incarnationReplaced =
        retained.incarnationId !== null &&
        pty !== undefined &&
        pty.incarnationId !== retained.incarnationId
      if (!pty || incarnationReplaced || leaves.length > 1) {
        this.invalidatePtyIncarnationHandle(ptyId)
        continue
      }
      // No pane shows it: a known incarnation keeps naming the process for exit waits beside the
      // terminal's own handle, and binds no surface; an unknown one proves nothing to keep.
      if (leaves.length === 0) {
        if (retained.incarnationId === null) {
          this.invalidatePtyIncarnationHandle(ptyId)
        }
        continue
      }
      if (this.handleByPtyId.has(ptyId)) {
        this.invalidatePtyIncarnationHandle(ptyId)
        continue
      }
      this.terminalIdentity.setIncarnationProcess(retained, pty.incarnationId)
      this.bindPtyIncarnationHandle(retained, leaves[0])
    }
  }

  protected adoptPreAllocatedHandle(leaf: RuntimeLeafRecord): string | null {
    if (!leaf.ptyId) {
      return null
    }
    const preAllocated = this.handleByPtyId.get(leaf.ptyId)
    if (!preAllocated) {
      return null
    }
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    this.terminalIdentity.setHandle(preAllocated, {
      handle: preAllocated,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.terminalIdentity.bindLeaf(leafKey, preAllocated)
    return preAllocated
  }

  protected issuePtyHandle(
    pty: RuntimePtyWorktreeRecord,
    context?: TerminalIdentityReadContext
  ): string {
    const handle = this.issuePtyHandleRecord(pty, context)
    // An unbound terminal retains its issued pane stamp for recovery, including after replacement.
    const record = ORCA_LAYOUT_OWNER_IS_MAIN ? this.handles.get(handle) : undefined
    const issuedForPaneKey = record && (context ? context.paneOf(pty) : this.paneOfPty(pty)).paneKey
    if (record && issuedForPaneKey && record.issuedForPaneKey !== issuedForPaneKey) {
      this.terminalIdentity.setHandle(handle, { ...record, issuedForPaneKey })
    }
    context?.changedHandle(handle)
    context?.changedReverseBinding(pty.ptyId)
    return handle
  }

  private issuePtyHandleRecord(
    pty: RuntimePtyWorktreeRecord,
    context?: TerminalIdentityReadContext
  ): string {
    const retained = this.handleByPtyIncarnation.get(pty.ptyId)
    // A paneless alias only answers exit waits; the terminal itself gets its own handle, as unshown terminals do.
    if (
      retained?.incarnationId === pty.incarnationId &&
      this.getLeavesForPty(pty.ptyId).length > 0
    ) {
      return retained.handle
    }
    const existingHandle =
      this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId, context)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.runtimeId === this.runtimeId &&
        existingRecord.ptyId === pty.ptyId
      ) {
        this.setPtyHandle(pty.ptyId, existingHandle)
        return existingHandle
      }
    }

    const handle = existingHandle ?? `term_${randomUUID()}`
    if (!existingHandle) {
      this.terminalIdentity.addSynthetic(handle)
    }
    const syntheticId = `pty:${pty.ptyId}`
    this.terminalIdentity.setHandle(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.setPtyHandle(pty.ptyId, handle)
    return handle
  }

  protected findHandleForPtyRecord(
    ptyId: string,
    context?: TerminalIdentityReadContext
  ): string | null {
    const candidates = context ? context.syntheticHandles(ptyId) : this.handles.keys()
    for (const handle of candidates) {
      const record = this.handles.get(handle)
      if (!record) {
        continue
      }
      if (
        record.runtimeId === this.runtimeId &&
        record.ptyId === ptyId &&
        record.tabId.startsWith('pty:')
      ) {
        return handle
      }
    }
    return null
  }

  protected refreshWritableFlags(): void {
    for (const leaf of this.leaves.values()) {
      leaf.writable = this.graphStatus === 'ready' && leaf.connected && leaf.ptyId !== null
    }
  }

  protected invalidateLeafHandle(leafKey: string): void {
    const handle = this.handleByLeafKey.get(leafKey)
    if (!handle) {
      return
    }
    const record = this.handles.get(handle)
    const retained = record?.ptyId ? this.handleByPtyIncarnation.get(record.ptyId) : undefined
    this.terminalIdentity.unbindLeaf(leafKey)
    this.terminalIdentity.removeHandle(handle)
    // A pane-issued handle names its PTY incarnation, which outlives the pane: a late exit wait
    // still reads that record until it is pruned or replaced. An unknown incarnation proves no
    // continuity, so its alias goes with the pane.
    if (retained?.handle === handle && retained.incarnationId !== null) {
      return
    }
    if (record?.ptyId && retained?.handle === handle) {
      this.terminalIdentity.removeIncarnation(record.ptyId)
    }
    this.terminalIdentity.removeSynthetic(handle)
  }

  protected adoptFirstPtyForLeafHandle(
    leafKey: string,
    ptyId: string | null,
    ptyGeneration: number
  ): boolean {
    const handle = this.handleByLeafKey.get(leafKey)
    const record = handle ? this.handles.get(handle) : null
    if (!handle || !record || record.ptyId !== null || ptyId === null) {
      return false
    }
    this.terminalIdentity.setHandle(handle, { ...record, ptyId, ptyGeneration })
    return true
  }

  protected rememberDetachedPreAllocatedLeaves(): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId && this.handleByPtyId.has(leaf.ptyId)) {
        // Agent identity via ORCA_TERMINAL_HANDLE must survive renderer graph loss while the PTY lives.
        this.detachedPreAllocatedLeaves.set(leaf.ptyId, leaf)
      }
    }
  }
  protected issueHandle(leaf: RuntimeLeafRecord, context?: TerminalIdentityReadContext): string {
    const retained = leaf.ptyId ? this.handleByPtyIncarnation.get(leaf.ptyId)?.handle : undefined
    const handle = this.issueLeafHandleRecord(leaf)
    if (retained) {
      context?.changedHandle(retained)
    }
    context?.changedHandle(handle)
    return handle
  }

  private issueLeafHandleRecord(leaf: RuntimeLeafRecord): string {
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
    this.terminalIdentity.addSynthetic(handle)
    this.terminalIdentity.setHandle(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.terminalIdentity.bindLeaf(leafKey, handle)
    if (leaf.ptyId) {
      this.terminalIdentity.setIncarnation(leaf.ptyId, { handle, incarnationId, leafKey })
      this.wakeMailForNewPtyHandle(leaf.ptyId)
    }
    return handle
  }
}
