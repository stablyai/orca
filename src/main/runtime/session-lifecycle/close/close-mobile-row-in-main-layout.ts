// In main-owned layouts, phone row closes use main's pane/tab close with or without a window.
import { OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose } from './refuse-unattributed-mobile-session-tab-close'
import type {
  RuntimeMobileSessionTerminalTab,
  RuntimeSessionTabCloseReason
} from '../../../../shared/runtime-types'
import { startedMainTerminalSurfaces } from '../../terminal/surface/main-terminal-surfaces'
import {
  closeInMainLayout,
  type MainLayoutClose
} from '../../session-tabs/main-layout-close-command'
import type { ExplicitCloseStop } from '../../session-tabs/explicit-terminal-close-pty-stops'
import { retireTerminalSurfacesFromSnapshot } from '../../mobile-session-terminal-retirement'

export abstract class OrcaRuntimeWithCloseMobileRowInMainLayout extends OrcaRuntimeWithRefuseUnattributedMobileSessionTabClose {
  protected abstract stopExplicitlyClosedTabPtys(
    ptyIds: readonly string[],
    addressedPtyId: string
  ): Promise<ExplicitCloseStop>

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
    if (!surfaces?.ownsWorkspace(worktreeId)) {
      return null
    }
    const close = await closeInMainLayout(
      {
        panesOfTab: (id) => surfaces.panesOfTab(id),
        applyLayoutCommand: (command) => this.applyLayoutCommand(command),
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
    if (close) {
      this.retireMainClosedRows(worktreeId, row.parentTabId, close.closesTab ? null : row.leafId)
    }
    return close
  }

  /** Retire rows immediately: window snapshots and exiting SSH registrations lag main's close. leafId=null retires the tab. Interim until main merges layout per commit (L260). */
  private retireMainClosedRows(worktreeId: string, tabId: string, leafId: string | null): void {
    let snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const rows = (snapshot?.tabs ?? []).filter(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === tabId &&
        (leafId === null || candidate.leafId === leafId)
    )
    for (const row of rows) {
      const proof = snapshot && this.getMobileSessionTerminalRetirementProof(worktreeId, row)
      const retired =
        snapshot &&
        retireTerminalSurfacesFromSnapshot({
          snapshot,
          ptyId: row.ptyId ?? row.parentLayout?.ptyIdsByLeafId?.[row.leafId] ?? '',
          exactSurfaces: [{ parentTabId: tabId, leafId: row.leafId }],
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
