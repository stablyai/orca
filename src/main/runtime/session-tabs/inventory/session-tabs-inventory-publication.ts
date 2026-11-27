import type { PtyControllerInventory } from '../../terminal/lifecycle/runtime-pty-controller-contract'
import {
  type ExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees } from './session-tabs-inventory'

// Bounds how stale a reused census may be: a terminal the controller holds but the runtime was never told about
// shows up within this long, while a burst of reads still shares one census.
const LOCAL_TERMINAL_CENSUS_REUSE_MS = 1_000

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

  private localTerminalCensus: { receipt: () => boolean; takenAt: number } | null = null
  private pendingLocalTerminalCensus: Promise<(() => boolean) | null> | null = null

  /** A census of this machine's terminals, the only ones callers ask after. Reads within a second share its receipt,
   *  which stays current only while the same controller and published graph own the census. */
  refreshAuthoritativeTerminalInventory(): Promise<(() => boolean) | null> {
    const census = this.localTerminalCensus
    if (
      census &&
      performance.now() - census.takenAt < LOCAL_TERMINAL_CENSUS_REUSE_MS &&
      census.receipt()
    ) {
      return Promise.resolve(census.receipt)
    }
    this.pendingLocalTerminalCensus ??= this.takeLocalTerminalCensus().finally(() => {
      this.pendingLocalTerminalCensus = null
    })
    return this.pendingLocalTerminalCensus
  }

  private async takeLocalTerminalCensus(): Promise<(() => boolean) | null> {
    const epoch = this.getAuthoritativeSessionTabsInventoryEpoch()
    if (epoch === null || !this.ptyController) {
      return null
    }
    const generation = this.ptyControllerGeneration
    const takenAt = performance.now()
    const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
      await this.listResolvedWorktrees(),
      null,
      undefined,
      null,
      false,
      {
        includeForegroundProcessEvidence: false,
        refreshForegroundAgents: false,
        supersedesPendingListings: false
      }
    )
    if (!inventory) {
      return null
    }
    const receipt = () =>
      this.ptyControllerGeneration === generation &&
      this.getAuthoritativeSessionTabsInventoryEpoch() === epoch
    this.localTerminalCensus = { receipt, takenAt }
    return receipt
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
    return !!inventory && !this.knowsTerminalHostOutside(inventory.queriedHostIds)
  }

  /** Whether a terminal could live on a known host the local census never asks. */
  knowsNonLocalTerminalHost(): boolean {
    return this.knowsTerminalHostOutside(new Set([LOCAL_EXECUTION_HOST_ID]))
  }

  private knowsTerminalHostOutside(queriedHostIds: ReadonlySet<ExecutionHostId>): boolean {
    const knownHostIds = this.listKnownExecutionHostIds(queriedHostIds)
    return [...knownHostIds].some((hostId) => {
      const parsed = parseExecutionHostId(hostId)
      return parsed?.kind !== 'runtime' && !queriedHostIds.has(hostId)
    })
  }
}
