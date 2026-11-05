import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import { RuntimeWorkspaceFileTargets } from '../workspaces/workspace-file-session-targets'
export abstract class RuntimeMobileSessionTabSubscriptions extends RuntimeWorkspaceFileTargets {
  onMobileSessionTabsChanged(
    listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void,
    clientNavigationId?: string,
    clientKind?: 'mobile' | 'runtime'
  ): () => void {
    // Drain coalesced notifications before subscribing: the initial snapshot already includes them.
    this.mobileSessionTabsNotifyCoalescer.flushAll()
    const subscription = { listener, clientNavigationId, clientKind }
    this.mobileSessionTabListeners.add(subscription)
    return () => {
      // Flush before removal so this listener receives the latest settled state.
      this.mobileSessionTabsNotifyCoalescer.flushAll()
      const removed = this.mobileSessionTabListeners.delete(subscription)
      if (removed && clientKind !== 'mobile') {
        this.releaseAgentSenderHistoryIfUnobserved()
      }
      if (this.mobileSessionTabListeners.size === 0) {
        this.mobileSessionTabsAgentStatusHeartbeat.cancelPending()
      }
    }
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
  }
}
