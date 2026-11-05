import { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab } from './mobile-session-publication-preservation'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { AgentSenderRevision } from '../../../shared/agent-sender-associations'

export abstract class OrcaRuntimeWithSessionTabSenders extends OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab {
  /** One lazy sender preparation is shared by all scopes of this delivery pass. */
  protected createMobileSessionTabsDelivery() {
    let senderScope: ReturnType<typeof this.agentProjections.senders.immediateFramePass> | undefined
    return (
      result: RuntimeMobileSessionTabsResult,
      changeSequence: number,
      clientNavigationId?: string
    ): void => {
      const subscriptions = [...this.mobileSessionTabListeners].filter(
        (subscription) =>
          clientNavigationId === undefined || subscription.clientNavigationId === clientNavigationId
      )
      const snapshot = this.mobileSessionTabsByWorktree.get(result.worktree)
      const deliver = (desktopFrame: RuntimeMobileSessionTabsResult): void => {
        const { agentSenderAssociations: _senders, ...tabsOnly } = result
        let desktopDelivered = false
        for (const subscription of subscriptions) {
          if (this.mobileSessionTabsByWorktree.get(result.worktree) !== snapshot) {
            return
          }
          if (!this.mobileSessionTabListeners.has(subscription)) {
            continue
          }
          const desktop = subscription.clientKind !== 'mobile'
          const frame = desktop ? desktopFrame : tabsOnly
          // A frame for one client is already its projection; projecting again stacks the epoch suffix and revision, so the client fences it.
          subscription.listener(
            clientNavigationId === undefined
              ? this.projectMobileSessionTabsForClient(frame, subscription.clientNavigationId)
              : frame,
            changeSequence
          )
          desktopDelivered ||= desktop
        }
        if (
          clientNavigationId === undefined &&
          desktopDelivered &&
          this.mobileSessionTabsByWorktree.get(result.worktree) === snapshot &&
          desktopFrame.agentSenderAssociations
        ) {
          this.agentProjections.senders.acknowledgeFrame(
            result.worktree,
            desktopFrame.agentSenderAssociations
          )
        }
      }
      try {
        if (
          result.agentSenderAssociations ||
          !subscriptions.some((subscription) => subscription.clientKind !== 'mobile')
        ) {
          deliver(result)
          return
        }
        senderScope ??= this.agentProjections.senders.immediateFramePass()
        deliver({ ...result, agentSenderAssociations: senderScope(result.worktree) })
      } finally {
        this.releaseAgentSenderHistoryIfUnobserved()
      }
    }
  }

  protected async agentSenderGraphReply(base: AgentSenderRevision | undefined) {
    try {
      return await this.agentProjections.senders.buildForGraph(base)
    } finally {
      this.releaseAgentSenderHistoryIfUnobserved()
    }
  }

  protected async toMobileSessionTabsFrame(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    includeAgentSenders = true
  ): Promise<RuntimeMobileSessionTabsResult> {
    const result = this.toMobileSessionTabsResult(snapshot)
    return includeAgentSenders ? this.withMobileSessionTabSenders(result) : result
  }

  protected async withMobileSessionTabSenders(
    result: RuntimeMobileSessionTabsResult
  ): Promise<RuntimeMobileSessionTabsResult> {
    const occupant = this.mobileSessionTabsByWorktree.get(result.worktree)?.publicationEpoch
    try {
      const publication = await this.agentProjections.senders.buildForFrame(result.worktree)
      if (this.mobileSessionTabsByWorktree.get(result.worktree)?.publicationEpoch !== occupant) {
        throw new Error('session_tabs_inventory_unstable')
      }
      return { ...result, agentSenderAssociations: publication }
    } finally {
      this.releaseAgentSenderHistoryIfUnobserved()
    }
  }

  protected async toMobileSessionTabsFrames(
    snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>,
    includeAgentSenders = true
  ): Promise<RuntimeMobileSessionTabsResult[]> {
    const captured = [...snapshots]
    const results = captured.map((snapshot) => this.toMobileSessionTabsResult(snapshot))
    if (!includeAgentSenders || results.length === 0) {
      return results
    }
    try {
      const scope = await this.agentProjections.senders.buildForFramePass()
      if (
        captured.some(
          (snapshot) =>
            this.mobileSessionTabsByWorktree.get(snapshot.worktree)?.publicationEpoch !==
            snapshot.publicationEpoch
        )
      ) {
        throw new Error('session_tabs_inventory_unstable')
      }
      return results.map((result) => ({
        ...result,
        agentSenderAssociations: scope(result.worktree)
      }))
    } finally {
      this.releaseAgentSenderHistoryIfUnobserved()
    }
  }
}
