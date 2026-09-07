// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithBuildPtyTerminalSummary } from './orca-runtime-build-pty-terminal-summary'
import type { PtyIncarnationHandleRecord } from './orca-runtime-core'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { randomUUID } from 'node:crypto'

export class OrcaRuntimeWithBindPtyIncarnationHandle extends OrcaRuntimeWithBuildPtyTerminalSummary {
  protected bindPtyIncarnationHandle(
    retained: PtyIncarnationHandleRecord,
    leaf: RuntimeLeafRecord
  ): void {
    const leafKey = this.getLeafKey(leaf.tabId, leaf.leafId)
    if (retained.leafKey !== leafKey) {
      if (this.handleByLeafKey.get(retained.leafKey) === retained.handle) {
        this.handleByLeafKey.delete(retained.leafKey)
      }
      retained.leafKey = leafKey
    }
    this.handles.set(retained.handle, {
      handle: retained.handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, retained.handle)
  }

  protected invalidatePtyIncarnationHandle(ptyId: string): void {
    const retained = this.handleByPtyIncarnation.get(ptyId)
    if (!retained) {
      return
    }
    this.handleByPtyIncarnation.delete(ptyId)
    if (this.handleByLeafKey.get(retained.leafKey) === retained.handle) {
      this.handleByLeafKey.delete(retained.leafKey)
    }
    this.handles.delete(retained.handle)
    this.syntheticTerminalHandles.delete(retained.handle)
    this.rejectWaitersForHandle(retained.handle, 'terminal_handle_stale')
  }

  protected clearPtyIncarnationHandles(): void {
    for (const retained of this.handleByPtyIncarnation.values()) {
      this.syntheticTerminalHandles.delete(retained.handle)
    }
    this.handleByPtyIncarnation.clear()
  }

  protected reconcilePtyIncarnationHandles(): void {
    for (const [ptyId, retained] of this.handleByPtyIncarnation) {
      const pty = this.ptysById.get(ptyId)
      const leaves = this.getLeavesForPty(ptyId)
      if (
        !pty?.incarnationId ||
        pty.incarnationId !== retained.incarnationId ||
        leaves.length !== 1 ||
        this.handleByPtyId.has(ptyId)
      ) {
        this.invalidatePtyIncarnationHandle(ptyId)
        continue
      }
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
    this.handles.set(preAllocated, {
      handle: preAllocated,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      ptyId: leaf.ptyId,
      ptyGeneration: leaf.ptyGeneration
    })
    this.handleByLeafKey.set(leafKey, preAllocated)
    return preAllocated
  }

  protected issuePtyHandle(pty: RuntimePtyWorktreeRecord): string {
    const existingHandle =
      this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
    if (existingHandle) {
      const existingRecord = this.handles.get(existingHandle)
      if (
        existingRecord &&
        existingRecord.runtimeId === this.runtimeId &&
        existingRecord.ptyId === pty.ptyId
      ) {
        this.handleByPtyId.set(pty.ptyId, existingHandle)
        return existingHandle
      }
    }

    const handle = existingHandle ?? `term_${randomUUID()}`
    if (!existingHandle) {
      this.syntheticTerminalHandles.add(handle)
    }
    const syntheticId = `pty:${pty.ptyId}`
    this.handles.set(handle, {
      handle,
      runtimeId: this.runtimeId,
      rendererGraphEpoch: this.rendererGraphEpoch,
      worktreeId: pty.worktreeId,
      tabId: syntheticId,
      leafId: syntheticId,
      ptyId: pty.ptyId,
      ptyGeneration: 0
    })
    this.handleByPtyId.set(pty.ptyId, handle)
    return handle
  }

  protected findHandleForPtyRecord(ptyId: string): string | null {
    for (const [handle, record] of this.handles) {
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
    if (record?.ptyId && this.handleByPtyIncarnation.get(record.ptyId)?.handle === handle) {
      this.handleByPtyIncarnation.delete(record.ptyId)
    }
    this.handleByLeafKey.delete(leafKey)
    this.handles.delete(handle)
    this.syntheticTerminalHandles.delete(handle)
    this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
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
    this.handles.set(handle, { ...record, ptyId, ptyGeneration })
    return true
  }

  protected rememberDetachedPreAllocatedLeaves(): void {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId && this.handleByPtyId.has(leaf.ptyId)) {
        // Why: ORCA_TERMINAL_HANDLE is an agent identity, so CLI control survives renderer graph loss while the PTY is alive.
        this.detachedPreAllocatedLeaves.set(leaf.ptyId, leaf)
      }
    }
  }
}
