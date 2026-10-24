import { OrcaRuntimeWithResolveKnownWorkspaceFileTarget } from '../../workspaces/known-workspace-file-target'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import {
  getConnectionExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

export abstract class OrcaRuntimeWithInvalidateAllHandlesForPty extends OrcaRuntimeWithResolveKnownWorkspaceFileTarget {
  protected abstract getOrCreatePtyWorktreeRecord(ptyId: string): RuntimePtyWorktreeRecord | null

  protected abstract rejectWaitersForHandle(handle: string, code: string): void

  protected retirePredecessorPtyExitEvidence(pty: RuntimePtyWorktreeRecord): void {
    pty.lastExitCode = null
    pty.lastExitCause = null
    for (const leaf of this.getLeavesForPty(pty.ptyId)) {
      leaf.lastExitCode = null
      leaf.lastExitCause = null
    }
  }

  protected invalidateAllHandlesForPty(ptyId: string, preserveHandle?: string): Set<string> {
    const incarnationHandle = this.handleByPtyIncarnation.get(ptyId)?.handle
    const preallocatedHandle = this.handleByPtyId.get(ptyId)
    const invalidated = new Set<string>()
    if (incarnationHandle && incarnationHandle !== preserveHandle) {
      this.handleByPtyIncarnation.delete(ptyId)
      invalidated.add(incarnationHandle)
    } else if (incarnationHandle) {
      // Retain only the requested direct alias; drop incarnation-specific leaf identity.
      this.handleByPtyIncarnation.delete(ptyId)
    }
    if (preallocatedHandle && preallocatedHandle !== preserveHandle) {
      this.handleByPtyId.delete(ptyId)
      invalidated.add(preallocatedHandle)
    }
    for (const [handle, record] of this.handles) {
      if (record.ptyId === ptyId && handle !== preserveHandle) {
        invalidated.add(handle)
      }
    }
    for (const handle of invalidated) {
      this.handles.delete(handle)
      this.syntheticTerminalHandles.delete(handle)
      this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
    }
    for (const [leafKey, handle] of this.handleByLeafKey) {
      if (invalidated.has(handle) || (preserveHandle !== undefined && handle === preserveHandle)) {
        this.handleByLeafKey.delete(leafKey)
      }
    }
    if (preserveHandle !== undefined) {
      // Only the direct alias survives incarnation changes; rebuild predecessor pane records before reuse.
      this.handles.delete(preserveHandle)
      this.syntheticTerminalHandles.delete(preserveHandle)
    }
    return invalidated
  }

  protected replaceSyntheticTerminalHandlesForRestoredPty(
    ptyId: string,
    controllerHandle: string
  ): boolean {
    const boundHandles = new Set<string>()
    const directHandle = this.handleByPtyId.get(ptyId)
    if (directHandle) {
      boundHandles.add(directHandle)
    }
    for (const [handle, record] of this.handles) {
      if (record.ptyId === ptyId) {
        boundHandles.add(handle)
      } else if (handle === controllerHandle) {
        return false
      }
    }
    for (const [otherPtyId, handle] of this.handleByPtyId) {
      if (otherPtyId !== ptyId && handle === controllerHandle) {
        return false
      }
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        boundHandles.add(handle)
      }
    }
    if (
      boundHandles.size === 0 ||
      [...boundHandles].some(
        (handle) => handle === controllerHandle || !this.syntheticTerminalHandles.has(handle)
      )
    ) {
      return false
    }
    this.invalidateAllHandlesForPty(ptyId)
    return true
  }

  // Adoption is first-wins: re-keying strands old-handle waiters, and provider handles cannot steal another PTY's identity.
  protected isTerminalHandleAdoptionBlocked(ptyId: string, handle: string): boolean {
    if (this.handleByPtyId.get(ptyId) ?? this.findHandleForPtyRecord(ptyId)) {
      return true
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const issued = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (issued && issued !== handle) {
        return true
      }
    }
    const existingRecord = this.handles.get(handle)
    if (existingRecord && existingRecord.ptyId !== ptyId) {
      return true
    }
    for (const [otherPtyId, otherHandle] of this.handleByPtyId) {
      if (otherHandle === handle && otherPtyId !== ptyId) {
        return true
      }
    }
    return false
  }

  protected invalidatePtyControllerInventoryForLifecycle(
    ptyId: string,
    connectionId?: string | null
  ): void {
    const generation = ++this.ptyControllerInventorySequence
    const hostId = getPtyExecutionHost(ptyId)
    if (hostId === 'foreign' || (hostId && parseExecutionHostId(hostId)?.kind === 'runtime')) {
      this.ptyControllerAggregateInventoryGeneration = generation
      return
    }
    const connection =
      connectionId === undefined ? this.ptysById.get(ptyId)?.connectionId : connectionId
    const providerKey = hostId ?? getConnectionExecutionHostId(connection)
    // A pending census predates this admission or exit, including legacy IDs without an incarnation.
    this.ptyControllerInventoryGenerationByProvider.set(providerKey, generation)
  }

  onPtySpawned(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    options: { awaitsRegistration?: boolean } = {}
  ): void {
    this.invalidatePtyControllerInventoryForLifecycle(ptyId)
    const existingPty = this.ptysById.get(ptyId)
    if (
      existingPty &&
      incarnationId !== undefined &&
      existingPty.incarnationId !== null &&
      existingPty.incarnationId !== incarnationId
    ) {
      // Fence predecessors when providers announce children, before pane binding commits, so reused ids cannot route through stale handles.
      this.rememberPtyHandleReplacementFence(
        ptyId,
        incarnationId,
        this.invalidateAllHandlesForPty(ptyId),
        true
      )
      if (incarnationId) {
        this.retirePredecessorPtyExitEvidence(existingPty)
      }
    }
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.stopRequestedPtyIds.delete(ptyId)
    if (options.awaitsRegistration !== false) {
      // Why: surface absence cannot distinguish an in-flight admission from a completed headless lifecycle.
      const pending = this.pendingPtyRegistrationIncarnations.get(ptyId)
      if (pending && (pending.incarnationId === null || pending.incarnationId === incarnationId)) {
        pending.incarnationId = incarnationId ?? null
      } else {
        this.pendingPtyRegistrationIncarnations.set(ptyId, {
          incarnationId: incarnationId ?? null,
          exitedIncarnations: new Set()
        })
      }
    }
    this.terminalViewSubscribers.markSpawnPublished(ptyId)
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      if (incarnationId) {
        pty.incarnationId = incarnationId
      }
      pty.connected = true
      pty.disconnectedAt = null
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      this.adoptPreAllocatedHandle(leaf)
    }
  }
}
