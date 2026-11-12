import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { RuntimeWorkspaceFileTargets } from '../workspaces/workspace-file-session-targets'
export abstract class RuntimeMobileSessionTabSubscriptions extends RuntimeWorkspaceFileTargets {
  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void,
    clientNavigationId?: string,
    clientKind?: 'mobile' | 'runtime',
    options?: { observation: 'caller' }
  ): () => void {
    // Drain coalesced notifications before subscribing: the initial snapshot already includes them.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = {
      listener,
      clientNavigationId,
      clientKind,
      observation: options?.observation
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
    subscription: {
      listener(frame: RuntimeMobileSessionTabsResult, sequence: number): void
      clientNavigationId?: string
      observation?: 'caller'
    },
    frame: RuntimeMobileSessionTabsResult,
    sequence: number
  ): void {
    subscription.listener(frame, sequence)
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
    observer?: object
  ): void {
    this.clientHostedPageReconciliation.observe(frames, clientNavigationId, observer)
  }

  forgetClientHostedPageObservation(
    clientNavigationId: string | undefined,
    observer: object
  ): void {
    this.clientHostedPageReconciliation.forgetObservation(clientNavigationId, observer)
  }

  protected hasAgentSenderListeners(): boolean {
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
