import { OrcaRuntimeWithFitOverrideListeners } from '../lifecycle/terminal-view-resources'
import {
  LocalWindowTerminalGrids,
  type LocalWindowTerminalGrid
} from '../../local-window-terminal-grids'
import type { RemoteDesktopTerminalFloor } from '../../remote-desktop-terminal-floor'
import type { DriverState, PtyLayoutState } from '../../orca-runtime-core'

export abstract class OrcaRuntimeWithLocalWindowTerminalGrids extends OrcaRuntimeWithFitOverrideListeners {
  protected abstract readonly remoteDesktopFloor: RemoteDesktopTerminalFloor
  protected abstract readonly layouts: Map<string, PtyLayoutState>
  protected abstract resolveDesktopRestoreTarget(ptyId: string): LocalWindowTerminalGrid
  abstract getDriver(ptyId: string): DriverState
  abstract getTerminalSize(ptyId: string): LocalWindowTerminalGrid | null
  protected abstract notifyFitOverrideListeners(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number,
    localSharedGrid?: boolean
  ): void

  private readonly localWindowSubscriptionKeys = new Set<string>()
  protected readonly localWindowTerminalGrids = new LocalWindowTerminalGrids({
    getTerminalSize: (ptyId) => this.getTerminalSize(ptyId),
    onChange: (ptyId, grid) => {
      if (
        !grid &&
        this.getDriver(ptyId).kind !== 'mobile' &&
        this.layouts.get(ptyId)?.kind !== 'phone'
      ) {
        const owner = this.remoteDesktopFloor.getOwnerSubscriptionKey(ptyId)
        const survivor = this.localWindowTerminalGrids.getVisibleLeases(ptyId)[0]
        if ((!owner || this.localWindowSubscriptionKeys.has(owner)) && survivor) {
          // Establish the survivor before clearing the hold so its first fit event is authoritative.
          const reclaim = survivor.leaseKey.startsWith('host:')
            ? this.remoteDesktopFloor.claimHost(ptyId, ...this.localHostGrid(ptyId))
            : this.remoteDesktopFloor.claimViewer(ptyId, survivor.leaseKey)
          void reclaim.catch(() => {})
        }
      }
      this.publishLocalWindowTerminalGrid(ptyId)
    }
  })

  private localHostGrid(ptyId: string): [number, number] {
    const grid = this.resolveDesktopRestoreTarget(ptyId)
    return [grid.cols, grid.rows]
  }

  getLocalSharedTerminalGrid(
    ptyId: string,
    subscriptionKey?: string
  ): LocalWindowTerminalGrid | null {
    if (this.getDriver(ptyId).kind === 'mobile' || this.layouts.get(ptyId)?.kind === 'phone') {
      return null
    }
    if (subscriptionKey && !this.localWindowSubscriptionKeys.has(subscriptionKey)) {
      return null
    }
    return this.localWindowTerminalGrids.getPinnedGrid(ptyId)
  }

  setLocalTerminalWindowVisible(windowId: number, visible: boolean): void {
    this.localWindowTerminalGrids.setWindowVisible(windowId, visible)
  }

  setLocalTerminalWindowLease(
    ptyId: string,
    leaseKey: string,
    windowId: number,
    visible: boolean
  ): void {
    if (!leaseKey.startsWith('host:')) {
      this.localWindowSubscriptionKeys.add(leaseKey)
    }
    this.localWindowTerminalGrids.setLease(ptyId, leaseKey, windowId, visible)
  }

  removeLocalTerminalWindowLease(ptyId: string, leaseKey: string): void {
    this.localWindowTerminalGrids.removeLease(ptyId, leaseKey)
    this.localWindowSubscriptionKeys.delete(leaseKey)
  }

  removeLocalTerminalWindow(windowId: number): void {
    this.localWindowTerminalGrids.removeWindow(windowId)
  }

  protected publishLocalWindowTerminalGrid(ptyId: string): void {
    if (this.getDriver(ptyId).kind === 'mobile' || this.layouts.get(ptyId)?.kind === 'phone') {
      return
    }
    const grid = this.getLocalSharedTerminalGrid(ptyId)
    const size = grid ?? this.getTerminalSize(ptyId)
    if (!size) {
      return
    }
    const mode =
      grid || this.remoteDesktopFloor.getOwnerSubscriptionKey(ptyId)
        ? 'remote-desktop-fit'
        : 'desktop-fit'
    this.notifier?.terminalFitOverrideChanged(ptyId, mode, size.cols, size.rows, !!grid)
    this.notifyFitOverrideListeners(ptyId, mode, size.cols, size.rows, !!grid)
  }
}
