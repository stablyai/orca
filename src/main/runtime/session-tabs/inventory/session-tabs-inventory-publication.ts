import type { PtyControllerInventory } from '../../terminal/lifecycle/runtime-pty-controller-contract'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees } from './session-tabs-inventory'

export abstract class RuntimeSessionTabsInventoryPublication extends OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees {
  /** A workspace's chat tabs, from the tab state alone: no PTY inventory, which only terminal tabs need.
   *  Bot reads (chats tree, Activity, Look around) ask this for a bot home, which has no terminals. */
  async listChatSessionTabs(worktreeId: string): Promise<{ sessionId: string; title: string }[]> {
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
      includeAgentSenders: false
    })
    return snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session' ? [{ sessionId: tab.sessionId, title: tab.title }] : []
    )
  }

  protected waitForSessionTabsInventoryPublication(signal?: AbortSignal): Promise<void> {
    if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.sessionTabsInventoryWaiters.delete(onPublished)
        signal?.removeEventListener('abort', onAbort)
      }
      const onPublished = (): void => {
        cleanup()
        resolve()
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      this.sessionTabsInventoryWaiters.add(onPublished)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
      } else if (this.getAuthoritativeSessionTabsInventoryEpoch() !== null) {
        onPublished()
      }
    })
  }

  protected getAuthoritativeSessionTabsInventoryEpoch(): number | null {
    return this.graphStatus === 'ready' &&
      this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch
      ? this.rendererGraphEpoch
      : null
  }

  protected markSessionTabsInventoryPublished(): void {
    if (this.sessionTabsInventoryPublicationEpoch === this.rendererGraphEpoch) {
      return
    }
    this.sessionTabsInventoryPublicationEpoch = this.rendererGraphEpoch
    for (const publish of Array.from(this.sessionTabsInventoryWaiters)) {
      publish()
    }
  }
  protected assertSessionTabsInventoryRequestActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('client_disconnected')
    }
  }

  protected isCompleteSessionTabsPtyCensus(inventory: PtyControllerInventory | null): boolean {
    if (!inventory) {
      return false
    }
    const knownHostIds = this.listKnownExecutionHostIds(inventory.queriedHostIds)
    return ![...knownHostIds].some((hostId) => {
      const parsed = parseExecutionHostId(hostId)
      return parsed?.kind !== 'runtime' && !inventory.queriedHostIds.has(hostId)
    })
  }
}
