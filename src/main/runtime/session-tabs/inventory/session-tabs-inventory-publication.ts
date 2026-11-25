import type { PtyControllerInventory } from '../../terminal/lifecycle/runtime-pty-controller-contract'
import {
  type ExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees } from './session-tabs-inventory'
import {
  SESSION_TAB_CLOSE_KEPT_ERROR,
  SESSION_TAB_NOT_FOUND_ERROR,
  type SessionTabAutomaticClose
} from '../../../../shared/workspace-layout/client-views/session-tab-close'

// Bounds how stale a reused census may be: a terminal the controller holds but the runtime was never told about
// shows up within this long, while a burst of reads still shares one census.
const LOCAL_TERMINAL_CENSUS_REUSE_MS = 1_000

/** A chat tab in a workspace: its session, title, and where it sits (front of its group, pinned). */
export type ChatSessionTabRow = {
  sessionId: string
  title: string
  tabId: string
  isActive: boolean
  isPinned?: true
}

export abstract class RuntimeSessionTabsInventoryPublication extends OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees {
  /** A workspace's chat tabs, from the tab state alone: no PTY inventory, which only terminal tabs need.
   *  Bot reads (chats tree, Activity, Look around) ask this for a bot home, which has no terminals. */
  async listChatSessionTabs(worktreeId: string): Promise<ChatSessionTabRow[]> {
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true
    })
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = await this.getMobileSessionTabsForWorktree(worktreeId, undefined, {
      includeAgentSenders: false
    })
    return snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [
            {
              sessionId: tab.sessionId,
              title: tab.title,
              tabId: tab.id,
              isActive: tab.isActive,
              ...(tab.isPinned ? { isPinned: true as const } : {})
            }
          ]
        : []
    )
  }

  /** Asks the window that owns the layout whether Orca may close this chat tab on its own; the window
   *  closes nothing. With no window to ask, the host's own tab state decides (consent). */
  async askChatTabAutomaticClose(
    worktreeId: string,
    tabId: string,
    automatic: SessionTabAutomaticClose
  ): Promise<'consent' | 'kept' | 'error'> {
    const notifier = this.notifier
    if (!notifier?.closeSessionTab) {
      return 'consent'
    }
    try {
      await notifier.closeSessionTab(tabId, worktreeId, automatic)
      return 'consent'
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (message === SESSION_TAB_CLOSE_KEPT_ERROR) {
        return 'kept'
      }
      // The window no longer has the tab: nothing there for a person to lose.
      return message === SESSION_TAB_NOT_FOUND_ERROR ? 'consent' : 'error'
    }
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
