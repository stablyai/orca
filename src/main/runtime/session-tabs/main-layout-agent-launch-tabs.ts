// Main-owned early launch tabs are written before launch and withdrawn through main close; paired-runtime workspaces retain window relay.
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './structured-session-tab-close'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch-tab-publication'
import type { AgentLaunchPlacementReceipt } from '../../../shared/agent-launch-intent'
import type { AgentLaunchPaneAddress } from '../../../shared/agent-launch-pane-verdict'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

/** Where the tab landed against where the launch asked for it, as the window reports it. */
function placementFallback(
  asked: AgentLaunchTabPublishRequest['placement'],
  landed: string,
  anchored: boolean
): AgentLaunchPlacementReceipt['fallback'] {
  if (asked?.groupId !== undefined) {
    return landed === asked.groupId ? undefined : anchored ? 'anchor-group' : 'active-group'
  }
  return asked?.afterTabId !== undefined && !anchored ? 'active-group' : undefined
}

export abstract class OrcaRuntimeWithMainLayoutAgentLaunchTabs extends OrcaRuntimeWithCloseStructuredAgentSessionTab {
  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null

  /** Whether a running process holds this pane now: such a pane is attached to, never launched into. */
  hasLiveTerminalForPaneKey(paneKey: string): boolean {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    // Main's bound terminal may survive listing gaps; only certified exit frees its pane.
    return ORCA_LAYOUT_OWNER_IS_MAIN
      ? !!pty && this.getPtyLivenessVerdict(pty.ptyId)?.status !== 'exited'
      : pty?.connected === true
  }

  /** Whether main's layout holds the tab's workspace, so main writes the tab itself. */
  private ownsLaunchTab(worktreeId: string, tabId: string): boolean {
    const hostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
    return Boolean(
      this.store?.applyLayoutCommand && parseExecutionHostId(hostId)?.kind !== 'runtime'
    )
  }

  private groupOfTab(worktreeId: string, tabId: string): string | undefined {
    return this.getWorkspaceSessionForWorktree(worktreeId)?.unifiedTabs?.[worktreeId]?.find(
      (tab) => tab.entityId === tabId
    )?.groupId
  }

  /** The launch's tab in main's layout; null for a workspace main does not own (today's path). */
  publishAgentLaunchTabInMainLayout(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
  ): Promise<AgentLaunchTabPublished> | null {
    const { worktreeId, tabId, leafId, placement } = request
    if (!this.ownsLaunchTab(worktreeId, tabId)) {
      return null
    }
    const existed = this.groupOfTab(worktreeId, tabId) !== undefined
    return this.applyLayoutCommand({
      type: 'createTerminalTab',
      workspace: worktreeId,
      tabId,
      leafId,
      viewMode: request.viewMode,
      ...(placement?.groupId ? { groupId: placement.groupId } : {}),
      ...(placement?.afterTabId ? { afterTabId: placement.afterTabId } : {}),
      creation: { launchAgent: request.launchAgent }
    }).then((reply) => {
      if (!reply.ok) {
        throw new Error(reply.code)
      }
      const landed = this.groupOfTab(worktreeId, tabId)
      if (!landed) {
        throw new Error('agent_launch_tab_unplaced')
      }
      this.showLaunchTabInWindow(request, { frameSeq: reply.frameSeq, created: !existed })
      // A retry naming the same tab finds it: the launch made no tab, so it takes none back.
      if (existed) {
        return { tabId, created: false, placement: { groupId: landed } }
      }
      const anchored =
        placement?.afterTabId !== undefined &&
        this.groupOfTab(worktreeId, placement.afterTabId) === landed
      const fallback = placementFallback(placement, landed, anchored)
      return {
        tabId,
        created: true,
        placement: { groupId: landed, ...(fallback ? { fallback } : {}) }
      }
    })
  }

  /** Keep window-owned launch outcome, copyable prompt and viewer rules while main owns the tab. */
  private showLaunchTabInWindow(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>,
    shownByMain: NonNullable<AgentLaunchTabPublishRequest['shownByMain']>
  ): void {
    if (!this.notifier?.publishAgentLaunchTab || !this.getAvailableAuthoritativeWindow()) {
      return
    }
    // Window display is advisory; launch never waits or fails on it.
    void this.notifier
      .publishAgentLaunchTab({ ...request, shownByMain })
      .catch((error: unknown) => {
        console.warn('[agent-launch] the window did not keep the launch tab main wrote', error)
      })
  }

  /** Withdraw main-owned launch panes, closing the tab for its last pane; false leaves unowned workspaces to window cleanup. */
  withdrawAgentLaunchPaneInMainLayout(pane: AgentLaunchPaneAddress): boolean {
    if (!this.ownsLaunchTab(pane.worktreeId, pane.tabId)) {
      return false
    }
    // The verdict is a report: a failed take-back leaves an idle pane, never a failed launch.
    void this.takeBackLaunchPane(pane).catch((error: unknown) => {
      console.warn('[agent-launch] could not take back a withdrawn launch pane', error)
    })
    return true
  }

  private async takeBackLaunchPane(pane: AgentLaunchPaneAddress): Promise<void> {
    const { worktreeId: workspace, tabId, leafId } = pane
    const reply = await this.applyLayoutCommand({ type: 'closePane', workspace, tabId, leafId })
    // A pane close keeps a tab's last pane; that pane goes with its tab.
    if (!reply.ok && reply.code === 'last_pane') {
      await this.applyLayoutCommand({
        type: 'closeTabs',
        workspace,
        tabIds: [tabId],
        recordClose: 'cleanup'
      })
    }
  }
}
