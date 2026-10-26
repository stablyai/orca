import type { OrcaRuntimeWithTransitionGraphReloadToTerminalState as TransitionGraphReloadToTerminalStateMethods } from './session-graph-authority'
import type { OrcaRuntimeWithBindPtyIncarnationHandle as BindPtyIncarnationHandleMethods } from '../terminal/identity/terminal-handle-bindings'
import type { OrcaRuntimeWithResolveWaiter as ResolveWaiterMethods } from '../orca-runtime-resolve-waiter'
import { OrcaRuntimeWithStopTerminalsForProject } from '../terminal/stop/project-terminal-stop'
import type { RuntimeRendererReloadFence } from '../orca-runtime-core'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'

export abstract class OrcaRuntimeWithHasTerminalsForWorktree extends OrcaRuntimeWithStopTerminalsForProject {
  protected abstract assertStableReadyGraph(
    ...args: Parameters<TransitionGraphReloadToTerminalStateMethods['assertStableReadyGraph']>
  ): ReturnType<TransitionGraphReloadToTerminalStateMethods['assertStableReadyGraph']>

  protected abstract captureReadyGraphEpoch(
    ...args: Parameters<TransitionGraphReloadToTerminalStateMethods['captureReadyGraphEpoch']>
  ): ReturnType<TransitionGraphReloadToTerminalStateMethods['captureReadyGraphEpoch']>

  protected abstract clearPtyIncarnationHandles(
    ...args: Parameters<BindPtyIncarnationHandleMethods['clearPtyIncarnationHandles']>
  ): ReturnType<BindPtyIncarnationHandleMethods['clearPtyIncarnationHandles']>

  protected abstract invalidatePtyIncarnationHandle(
    ...args: Parameters<BindPtyIncarnationHandleMethods['invalidatePtyIncarnationHandle']>
  ): ReturnType<BindPtyIncarnationHandleMethods['invalidatePtyIncarnationHandle']>

  protected abstract refreshWritableFlags(
    ...args: Parameters<BindPtyIncarnationHandleMethods['refreshWritableFlags']>
  ): ReturnType<BindPtyIncarnationHandleMethods['refreshWritableFlags']>

  protected abstract rejectAllWaiters(
    ...args: Parameters<ResolveWaiterMethods['rejectAllWaiters']>
  ): ReturnType<ResolveWaiterMethods['rejectAllWaiters']>

  protected abstract rejectWaitersForHandle(
    ...args: Parameters<ResolveWaiterMethods['rejectWaitersForHandle']>
  ): ReturnType<ResolveWaiterMethods['rejectWaitersForHandle']>

  protected abstract rememberDetachedPreAllocatedLeaves(
    ...args: Parameters<BindPtyIncarnationHandleMethods['rememberDetachedPreAllocatedLeaves']>
  ): ReturnType<BindPtyIncarnationHandleMethods['rememberDetachedPreAllocatedLeaves']>

  protected abstract restoreHeadlessGraphAuthority(
    ...args: Parameters<
      TransitionGraphReloadToTerminalStateMethods['restoreHeadlessGraphAuthority']
    >
  ): ReturnType<TransitionGraphReloadToTerminalStateMethods['restoreHeadlessGraphAuthority']>

  protected abstract shouldRestoreHeadlessGraph(
    ...args: Parameters<TransitionGraphReloadToTerminalStateMethods['shouldRestoreHeadlessGraph']>
  ): ReturnType<TransitionGraphReloadToTerminalStateMethods['shouldRestoreHeadlessGraph']>

  protected abstract transitionGraphReloadToTerminalState(
    ...args: Parameters<
      TransitionGraphReloadToTerminalStateMethods['transitionGraphReloadToTerminalState']
    >
  ): ReturnType<TransitionGraphReloadToTerminalStateMethods['transitionGraphReloadToTerminalState']>

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
    if (this.graphStatus !== 'ready') {
      return null
    }
    return { revision: this.beginGraphReload(windowId), recovery: 'renderer' }
  }

  protected beginGraphReload(windowId: number): number {
    // Compare incarnations against the rebuilt graph before staling proven process identities.
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
    // Preserve CLI handles and incarnation waiters across reload; graph adoption may rejoin the same PTY.
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
    if (fence.recovery === 'renderer') {
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
    _reason: 'renderer-frame-unavailable' | 'renderer-process-gone'
  ): void {
    if (windowId !== this.authoritativeWindowId) {
      return
    }
    if (this.graphStatus === 'ready') {
      this.beginGraphReload(windowId)
    }
    this.graphReloadLifecycle.settleActive('failure')
    this.transitionGraphReloadToTerminalState(windowId)
  }

  markGraphUnavailable(windowId: number): void {
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
    // Closed windows never republish; serve/main-owned layouts must reclaim the graph (#27292).
    if (ORCA_LAYOUT_OWNER_IS_MAIN || this.servesHeadlessGraph) {
      this.headlessGraphFallbackAvailable = true
    }
    if (this.shouldRestoreHeadlessGraph(windowId)) {
      this.pendingHeadlessPromotionWindowId = null
      this.restoreHeadlessGraphAuthority()
      return
    }
    // Without an authoritative graph, live-terminal operations must fail closed.
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
    // Keep pre-allocated CLI handles for reconnect adoption.
    this.rejectAllWaiters('terminal_handle_stale')
  }

  protected handleGraphReloadTimeout(windowId: number): void {
    if (windowId !== this.authoritativeWindowId || this.graphStatus !== 'reloading') {
      return
    }
    this.transitionGraphReloadToTerminalState(windowId)
  }
}
