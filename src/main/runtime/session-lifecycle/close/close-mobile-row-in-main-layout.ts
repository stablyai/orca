// In main-owned layouts, phone row closes use main's pane/tab close with or without a window.
import { OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose } from './refuse-unattributed-mobile-session-tab-close'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeSessionTabCloseReason
} from '../../../../shared/runtime-types'
import { startedMainTerminalSurfaces } from '../../terminal/surface/main-terminal-surfaces'
import {
  closeInMainLayout,
  type MainLayoutClose
} from '../../session-tabs/main-layout-close-command'
import type {
  ExplicitCloseScope,
  ExplicitCloseStop,
  ExplicitCloseTarget
} from '../../session-tabs/explicit-terminal-close-pty-stops'
import { retireTerminalSurfacesFromSnapshot } from '../../mobile-session-terminal-retirement'

export abstract class OrcaRuntimeWithCloseMobileRowInMainLayout extends OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose {
  protected abstract stopExplicitlyClosedTabPtys(
    targets: readonly ExplicitCloseTarget[],
    addressedPtyId: string
  ): Promise<ExplicitCloseStop>

  protected abstract captureExplicitCloseTargets(
    ptyIds: readonly string[],
    scope: ExplicitCloseScope
  ): ExplicitCloseTarget[]

  /** Close parent::leaf as a pane or parent as a tab; null falls back for workspaces/rows main does not own. */
  protected async closeMobileRowInMainLayout(
    worktreeId: string,
    tabId: string,
    row: RuntimeMobileSessionTerminalTab,
    options: {
      force?: boolean
      reason?: RuntimeSessionTabCloseReason
      localPtyTeardownOwnedExternally?: boolean
    }
  ): Promise<MainLayoutClose | null> {
    const surfaces = startedMainTerminalSurfaces(this)
    if (!surfaces?.ownsPlacement(worktreeId)) {
      return null
    }
    const acknowledge = this.captureTerminalTabRetirement(worktreeId, row.parentTabId)
    const rows = (this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs ?? []).flatMap(
      (candidate) =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === row.parentTabId &&
        (row.id !== tabId || candidate.leafId === row.leafId)
          ? [
              {
                row: candidate,
                proof: this.getMobileSessionTerminalRetirementProof(worktreeId, candidate)
              }
            ]
          : []
    )
    const close = await closeInMainLayout(
      {
        panesOfTab: (id) => surfaces.panesOfTab(id),
        applyLayoutCommand: (command) => this.applyLayoutCommand(command),
        capture: (ptyIds, scope) => this.captureExplicitCloseTargets(ptyIds, scope),
        stop: (ptyIds, addressed) => this.stopExplicitlyClosedTabPtys(ptyIds, addressed),
        remoteSessionIdOf: (id) =>
          this.getWorkspaceSessionForWorktree(worktreeId)?.remoteSessionIdsByTabId?.[id]
      },
      {
        worktreeId,
        tabId: row.parentTabId,
        leafId: row.leafId,
        wholeTab: row.id !== tabId,
        force: options.force,
        // A terminal-gone lifecycle echo does not authorize termination.
        stopEnded:
          options.localPtyTeardownOwnedExternally !== true &&
          (options.reason === undefined || options.reason === 'user')
      }
    )
    if (close?.outcome === 'closed' && acknowledge().matches) {
      this.retireMainClosedRows(worktreeId, rows)
    }
    return close
  }

  private retireMainClosedRows(
    worktreeId: string,
    rows: readonly {
      row: RuntimeMobileSessionTerminalTab
      proof: RuntimeMobileSessionRetiredTerminalSurface | null
    }[]
  ): void {
    let snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    for (const { row, proof } of rows) {
      const retired =
        snapshot &&
        retireTerminalSurfacesFromSnapshot({
          snapshot,
          ptyId: row.ptyId ?? row.parentLayout?.ptyIdsByLeafId?.[row.leafId] ?? '',
          exactSurfaces: [{ parentTabId: row.parentTabId, leafId: row.leafId }],
          exactOnly: true,
          ...(proof ? { retirementProofs: [proof] } : {})
        })
      snapshot = retired ? retired.snapshot : snapshot
    }
    if (snapshot && rows.length > 0) {
      this.storeMobileSessionSnapshot(worktreeId, snapshot)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }
}
