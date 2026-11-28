import { rendererStatusReplica } from '../../session-graph/renderer-status-replica'
import type {
  ClientHostedPageObservation,
  MobileSessionTabSubscription
} from '../../construction/runtime-identity-state'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { RuntimeWorkspaceFileTargets } from '../../workspaces/workspace-file-session-targets'
import { CHAT_PANE_ADDRESS_PREFIX } from '../../../../shared/agent-session/view/structured-agent-session-projection'
export abstract class RuntimeMobileSessionTabSubscriptions extends RuntimeWorkspaceFileTargets {
  onMobileSessionTabsChanged(
    listener: MobileSessionTabSubscription['listener'],
    clientNavigationId?: string,
    clientKind?: 'mobile' | 'runtime',
    options?: Pick<MobileSessionTabSubscription, 'observation' | 'acceptsWorktree' | 'scope'>
  ): () => void {
    // Drain coalesced notifications before subscribing: the initial snapshot already includes them.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = {
      listener,
      clientNavigationId,
      clientKind,
      observation: options?.observation,
      acceptsWorktree: options?.acceptsWorktree,
      scope: options?.scope
    }
    this.mobileSessionTabListeners.add(subscription)
    return () => {
      // Flush before removal so this listener receives the latest settled state.
      this.mobileSessionTabsNotifyCoalescer.flushAll()
      const removed = this.mobileSessionTabListeners.delete(subscription)
      this.clientHostedPageReconciliation.forgetObservation(clientNavigationId, subscription)
      if (removed && clientKind !== 'mobile') {
        this.releaseAgentSenderHistoryIfUnobserved()
      }
      if (this.mobileSessionTabListeners.size === 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.cancelPending()
      }
    }
  }

  protected deliverMobileSessionTabsFrame(
    subscription: MobileSessionTabSubscription,
    frame: RuntimeMobileSessionTabsResult,
    sequence: number,
    delivery?: 'reconciliation'
  ): void {
    // A new graph epoch cannot send a status-less phone frame before its seed snapshot.
    if (
      subscription.clientKind === 'mobile' &&
      this.graphStatus !== 'unavailable' &&
      rendererStatusReplica(this).awaitingSnapshot(frame.worktree, this.rendererGeneration)
    ) {
      return
    }
    subscription.listener(frame, sequence, delivery)
    if (
      subscription.observation === 'caller' ||
      !this.mobileSessionTabListeners.has(subscription)
    ) {
      return
    }
    this.clientHostedPageReconciliation.observe(
      [frame],
      subscription.clientNavigationId,
      subscription
    )
  }

  observeClientHostedPageSnapshots(
    frames: readonly RuntimeMobileSessionTabsResult[],
    clientNavigationId?: string,
    observer?: ClientHostedPageObservation
  ): void {
    this.clientHostedPageReconciliation.observe(frames, clientNavigationId, observer)
  }

  forgetClientHostedPageObservation(
    clientNavigationId: string | undefined,
    observer: ClientHostedPageObservation
  ): void {
    this.clientHostedPageReconciliation.forgetObservation(clientNavigationId, observer)
  }

  protected selectMobileSessionTabsListeners(
    worktree?: string,
    clientNavigationId?: string,
    candidates: Iterable<MobileSessionTabSubscription> = this.mobileSessionTabListeners
  ): MobileSessionTabSubscription[] {
    const selected: MobileSessionTabSubscription[] = []
    for (const subscription of candidates) {
      if (
        this.mobileSessionTabListeners.has(subscription) &&
        (clientNavigationId === undefined ||
          subscription.clientNavigationId === clientNavigationId) &&
        (worktree === undefined || subscription.acceptsWorktree?.(worktree) !== false)
      ) {
        selected.push(subscription)
      }
    }
    return selected
  }

  /** Whether a pane's hook status reaches any listener: chat-scoped listeners read chat panes only. */
  protected hasPaneStatusListeners(paneKey: string): boolean {
    return paneKey.startsWith(CHAT_PANE_ADDRESS_PREFIX)
      ? this.mobileSessionTabListeners.size > 0
      : this.hasTerminalStatusListeners()
  }

  protected hasTerminalStatusListeners(): boolean {
    for (const { scope } of this.mobileSessionTabListeners) {
      if (scope !== 'agent-sessions') {
        return true
      }
    }
    return false
  }

  protected hasAgentSenderListeners(): boolean {
    // The window applying graph replies reads senders too; releasing after each reply rebuilt history cold every time.
    if (
      this.authoritativeWindowId !== null &&
      this.authoritativeWindowId !== HEADLESS_RUNTIME_WINDOW_ID &&
      this.graphStatus !== 'unavailable'
    ) {
      return true
    }
    for (const { clientKind } of this.mobileSessionTabListeners) {
      if (clientKind !== 'mobile') {
        return true
      }
    }
    return false
  }

  protected releaseAgentSenderHistoryIfUnobserved(): void {
    if (!this.hasAgentSenderListeners()) {
      this.agentProjections.senders.releaseDerivedHistory()
    }
  }

  forgetClientNavigationState(clientNavigationId: string): void {
    this.clientSessionTabSelections.forgetClient(clientNavigationId)
    this.clientHostedPageReconciliation.forgetClient(clientNavigationId)
  }
}
