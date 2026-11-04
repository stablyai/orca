import type { OrcaRuntimeWithTouchMobileSessionTabsForWorktree as TouchMobileSessionTabsForWorktreeMethods } from '../session-tabs/mobile-session-membership'
import { OrcaRuntimeWithSyncWindowGraph } from './session-window-graph'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import {
  mainTerminalSurfaces,
  type MainTerminalSurfacesHost
} from '../terminal/surface/main-terminal-surfaces'
import type { WorkspaceLayoutReads } from '../workspace-layout-stream'
import type { RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import type { PtyPane, PtyPaneSource, PtyPaneOf } from '../terminal/surface/pty-pane-query'
import { paneOfPty } from '../terminal/surface/pty-pane-query'
import type { PaneStartStatuses } from '../pane-start-statuses'

export abstract class OrcaRuntimeWithMainSessionSurfaces extends OrcaRuntimeWithSyncWindowGraph {
  protected abstract applyMobileSessionRetirementFences(
    ...args: Parameters<
      TouchMobileSessionTabsForWorktreeMethods['applyMobileSessionRetirementFences']
    >
  ): ReturnType<TouchMobileSessionTabsForWorktreeMethods['applyMobileSessionRetirementFences']>

  abstract get workspaceLayoutReads(): WorkspaceLayoutReads
  declare protected readonly paneStartStatuses: PaneStartStatuses | null

  /** Layout-owner builds: the window's graph with main's own panes for what main owns. */
  protected withMainSurfaces(
    windowId: number,
    graph: RuntimeSyncWindowGraph
  ): RuntimeSyncWindowGraph {
    return this.mainSurfaces().withMainSurfaces(windowId, graph)
  }

  // Main's index answers with or without a window's graph: each layout write is a new partition.
  protected paneOfPty(pty: PtyPaneSource | null | undefined): PtyPane {
    return paneOfPty(pty, (ptyId) => this.mainSurfaces().findPaneForPty(ptyId))
  }

  protected captureTerminalPaneReader(): PtyPaneOf {
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      return (pty) => paneOfPty(pty, () => null)
    }
    const mainPane = this.mainSurfaces().capturePaneLookup()
    return (pty) => paneOfPty(pty, mainPane)
  }

  private mainSurfaces(): ReturnType<typeof mainTerminalSurfaces> {
    const host = (): MainTerminalSurfacesHost => ({
      store: () => this.store,
      reads: () => this.workspaceLayoutReads,
      homeHostId: (key) => this.tryGetWorkspaceSessionHostIdForWorktree(key),
      registered: (ptyId) => this.ptysById.get(ptyId) ?? null,
      // Certified exit only: a dropped relay leaves records disconnected but unverifiable.
      exited: (ptyId) => this.ptyLivenessVerdictByPtyId.get(ptyId)?.verdict.status === 'exited',
      live: (ptyId) => this.ptysById.get(ptyId)?.connected === true,
      paneStartFact: (paneKey, binding) => this.paneStartStatuses?.get(paneKey, binding) ?? null,
      readyGraphPublisher: () => (this.graphStatus === 'ready' ? this.authoritativeWindowId : null),
      publish: (publisher, next) => {
        this.syncWindowGraph(publisher, next, { includeAgentSenders: false })
      },
      heldRows: () => this.mobileSessionTabsByWorktree,
      replaceHeldRows: (worktreeId, next) => {
        this.storeMobileSessionSnapshot(worktreeId, next)
        this.scheduleMobileSessionTabsChanged(worktreeId)
      },
      fenceExited: (rows) => this.applyMobileSessionRetirementFences(rows)
    })
    return mainTerminalSurfaces(this, host)
  }
}
