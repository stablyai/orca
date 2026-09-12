// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStopExactTerminalsForWorktree } from './orca-runtime-stop-exact-terminals-for-worktree'
import type { RuntimeRendererReloadFence } from './orca-runtime-core'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

export class OrcaRuntimeWithHasTerminalsForWorktree extends OrcaRuntimeWithStopExactTerminalsForWorktree {
  async hasTerminalsForWorktree(worktreeSelector: string): Promise<boolean> {
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    for (const leaf of this.leaves.values()) {
      if (leaf.worktreeId === worktree.id && leaf.ptyId) {
        return true
      }
    }
    for (const pty of this.ptysById.values()) {
      if (pty.worktreeId === worktree.id && pty.connected) {
        return true
      }
    }
    return false
  }

  markRendererReloading(windowId: number): RuntimeRendererReloadFence | null {
    if (
      windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      this.headlessGraphFallbackAvailable
    ) {
      this.attachWindow(windowId)
      const revision = this.graphReloadLifecycle.getActiveRevision()
      return this.authoritativeWindowId === windowId && revision !== null
        ? { revision, recovery: 'headless' }
        : null
    }
    if (windowId !== this.authoritativeWindowId) {
      return null
    }
    if (this.graphStatus === 'reloading') {
      return {
        revision: this.graphReloadLifecycle.begin(windowId),
        recovery: this.shouldRestoreHeadlessGraph(windowId) ? 'headless' : 'reloading'
      }
    }
    if (this.graphStatus === 'unavailable' && this.rendererGeneration === null) {
      return null
    }
    const recovery = this.graphStatus === 'ready' ? 'renderer' : 'unavailable'
    return { revision: this.beginGraphReload(windowId), recovery }
  }

  protected beginGraphReload(windowId: number, retireDocument = true): number {
    if (retireDocument && this.rendererGeneration !== null) {
      this.retiredRendererGenerations.add(this.rendererGeneration)
    }
    // Why: the rebuilt graph decides whether an incarnation survived; do not stale proven process identities before that comparison.
    this.rendererGraphEpoch += 1
    this.graphStatus = 'reloading'
    const revision = this.graphReloadLifecycle.begin(windowId)
    this.setTerminalSideEffectConsumerAvailable(false)
    this.rememberDetachedPreAllocatedLeaves()
    // A null incarnation is safe within one graph diff, but cannot prove a same-id PTY survived a renderer reload.
    for (const [ptyId, retained] of this.handleByPtyIncarnation) {
      if (retained.incarnationId === null) {
        this.invalidatePtyIncarnationHandle(ptyId)
      }
    }
    const retainedHandles = new Set([
      ...this.handleByPtyId.values(),
      ...[...this.handleByPtyIncarnation.values()].map((record) => record.handle)
    ])
    for (const handle of this.terminalWaiters.handles()) {
      if (!retainedHandles.has(handle)) {
        this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
      }
    }
    this.handles.clear()
    this.handleByLeafKey.clear()
    // Why: handleByPtyId (pre-allocated CLI handles) survives reloads so CLI agents keep control; adoptPreAllocatedHandle re-links on the new graph.
    // Incarnation-scoped waiters survive a renderer reload; the rebuilt graph
    // may re-adopt the same PTY and resolve them without a false stale error.
    this.refreshWritableFlags()
    return revision
  }

  markRendererReloadCancelled(windowId: number, fence: RuntimeRendererReloadFence): boolean {
    if (
      windowId !== this.authoritativeWindowId ||
      this.graphStatus !== 'reloading' ||
      !this.graphReloadLifecycle.settle(fence.revision, 'cancelled')
    ) {
      return false
    }
    if (fence.recovery === 'headless' && this.shouldRestoreHeadlessGraph(windowId)) {
      this.restoreHeadlessGraphAuthority()
      return false
    }
    if (fence.recovery === 'renderer' || fence.recovery === 'unavailable') {
      if (this.rendererGeneration !== null) {
        this.retiredRendererGenerations.delete(this.rendererGeneration)
      }
      if (fence.recovery === 'unavailable') {
        this.graphStatus = 'unavailable'
        return true
      }
      const restoresPublishedInventory =
        this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch - 1
      this.graphStatus = 'ready'
      this.setTerminalSideEffectConsumerAvailable(true)
      for (const leaf of this.leaves.values()) {
        this.adoptPreAllocatedHandle(leaf)
      }
      this.reconcilePtyIncarnationHandles()
      this.refreshWritableFlags()
      if (restoresPublishedInventory) {
        this.markSessionTabsInventoryPublished()
      }
      return true
    }
    this.graphReloadLifecycle.begin(windowId)
    return false
  }

  markGraphReady(windowId: number): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphReloadLifecycle.settleActive('success')
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.headlessGraphFallbackAvailable = false
      this.pendingHeadlessPromotionWindowId = null
    }
    this.graphStatus = 'ready'
    this.setTerminalSideEffectConsumerAvailable(windowId !== HEADLESS_RUNTIME_WINDOW_ID)
    this.refreshWritableFlags()
  }

  markGraphReloadFailed(
    windowId: number,
    reason: 'renderer-frame-unavailable' | 'renderer-process-gone'
  ): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    if (reason === 'renderer-process-gone' && this.rendererGeneration !== null) {
      this.retiredRendererGenerations.add(this.rendererGeneration)
    }
    if (this.graphStatus === 'ready') {
      this.beginGraphReload(windowId, reason === 'renderer-process-gone')
    }
    this.graphReloadLifecycle.settleActive('failure')
    if (reason === 'renderer-frame-unavailable' && !this.shouldRestoreHeadlessGraph(windowId)) {
      // A failed send does not retire the document or its live PTY bindings.
      this.graphStatus = 'unavailable'
      this.setTerminalSideEffectConsumerAvailable(false)
      this.refreshWritableFlags()
      return
    }
    this.transitionGraphReloadToTerminalState(windowId)
  }

  markGraphUnavailable(windowId: number): void {
    if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
      this.retiredGraphWindowIds.add(windowId)
    }
    if (
      this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
      windowId === this.pendingHeadlessPromotionWindowId
    ) {
      this.pendingHeadlessPromotionWindowId = null
      return
    }
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    this.graphReloadLifecycle.settleActive('cancelled')
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.pendingHeadlessPromotionWindowId = null
      this.restoreHeadlessGraphAuthority()
      return
    }
    // Why: once the authoritative renderer graph disappears, fail closed for live-terminal ops instead of guessing from old state.
    if (this.graphStatus !== 'unavailable') {
      this.rendererGraphEpoch += 1
    }
    this.graphStatus = 'unavailable'
    this.setTerminalSideEffectConsumerAvailable(false)
    this.authoritativeWindowId = null
    this.rememberDetachedPreAllocatedLeaves()
    for (const [ptyId, handle] of this.handleByPtyId) {
      if (this.handleByPtyIncarnation.get(ptyId)?.handle === handle) {
        this.handleByPtyId.delete(ptyId)
      }
    }
    this.tabs.clear()
    this.leaves.clear()
    this.leavesByPtyId.clear()
    this.handles.clear()
    this.handleByLeafKey.clear()
    this.clearPtyIncarnationHandles()
    // Why: pre-allocated CLI handles must survive graph unavailability so they can be re-adopted on reconnect.
    this.rejectAllWaiters('terminal_handle_stale')
  }

  protected handleGraphReloadTimeout(windowId: number): void {
    if (windowId !== this.authoritativeWindowId || this.graphStatus !== 'reloading') {
      return
    }
    this.transitionGraphReloadToTerminalState(windowId)
  }
}
