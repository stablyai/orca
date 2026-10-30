export type LocalWindowTerminalGrid = { cols: number; rows: number }

type LocalWindowTerminalLease = { windowId: number; visible: boolean }

type LocalWindowTerminalGridDependencies = {
  getTerminalSize: (ptyId: string) => LocalWindowTerminalGrid | null
  onChange: (ptyId: string, grid: LocalWindowTerminalGrid | null) => void
}

/** Shared native views keep one ANSI grid while their window boxes resize independently. */
export class LocalWindowTerminalGrids {
  private readonly leases = new Map<string, Map<string, LocalWindowTerminalLease>>()
  private readonly visibleWindows = new Set<number>()
  private readonly pinnedGrids = new Map<string, LocalWindowTerminalGrid>()

  constructor(private readonly dependencies: LocalWindowTerminalGridDependencies) {}

  setWindowVisible(windowId: number, visible: boolean): void {
    if (this.visibleWindows.has(windowId) === visible) {
      return
    }
    if (visible) {
      this.visibleWindows.add(windowId)
    } else {
      this.visibleWindows.delete(windowId)
    }
    for (const [ptyId, leases] of this.leases) {
      if ([...leases.values()].some((lease) => lease.windowId === windowId)) {
        this.reconcile(ptyId)
      }
    }
  }

  setLease(ptyId: string, leaseKey: string, windowId: number, visible: boolean): void {
    let leases = this.leases.get(ptyId)
    if (!leases) {
      leases = new Map()
      this.leases.set(ptyId, leases)
    }
    leases.set(leaseKey, { windowId, visible })
    this.reconcile(ptyId)
  }

  removeLease(ptyId: string, leaseKey: string): void {
    const leases = this.leases.get(ptyId)
    if (!leases?.delete(leaseKey)) {
      return
    }
    if (leases.size === 0) {
      this.leases.delete(ptyId)
    }
    this.reconcile(ptyId)
  }

  removeWindow(windowId: number): void {
    this.visibleWindows.delete(windowId)
    for (const [ptyId, leases] of this.leases) {
      let changed = false
      for (const [key, lease] of leases) {
        if (lease.windowId === windowId) {
          leases.delete(key)
          changed = true
        }
      }
      if (leases.size === 0) {
        this.leases.delete(ptyId)
      }
      if (changed) {
        this.reconcile(ptyId)
      }
    }
  }

  clearPty(ptyId: string): void {
    this.leases.delete(ptyId)
    this.releasePin(ptyId)
  }

  getPinnedGrid(ptyId: string): LocalWindowTerminalGrid | null {
    const grid = this.pinnedGrids.get(ptyId)
    return grid ? { ...grid } : null
  }

  pinnedPtyIds(): Iterable<string> {
    return this.pinnedGrids.keys()
  }

  getVisibleLeases(ptyId: string): readonly { windowId: number; leaseKey: string }[] {
    const result: { windowId: number; leaseKey: string }[] = []
    for (const [leaseKey, lease] of this.leases.get(ptyId) ?? []) {
      if (lease.visible && this.visibleWindows.has(lease.windowId)) {
        result.push({ windowId: lease.windowId, leaseKey })
      }
    }
    return result
  }

  isLocalSubscription(ptyId: string, subscriptionKey: string): boolean {
    return this.leases.get(ptyId)?.has(subscriptionKey) === true
  }

  refreshPinnedGrid(ptyId: string): void {
    if (!this.pinnedGrids.has(ptyId)) {
      this.reconcile(ptyId)
      return
    }
    const grid = this.readCanonicalGrid(ptyId)
    const previous = this.pinnedGrids.get(ptyId)
    if (grid && (previous?.cols !== grid.cols || previous.rows !== grid.rows)) {
      this.pinnedGrids.set(ptyId, grid)
      this.dependencies.onChange(ptyId, { ...grid })
    }
  }

  private reconcile(ptyId: string): void {
    const windows = new Set(this.getVisibleLeases(ptyId).map((lease) => lease.windowId))
    if (windows.size < 2) {
      this.releasePin(ptyId)
      return
    }
    if (this.pinnedGrids.has(ptyId)) {
      return
    }
    const grid = this.readCanonicalGrid(ptyId)
    if (grid) {
      this.pinnedGrids.set(ptyId, grid)
      this.dependencies.onChange(ptyId, { ...grid })
    }
  }

  private readCanonicalGrid(ptyId: string): LocalWindowTerminalGrid | null {
    const grid = this.dependencies.getTerminalSize(ptyId)
    return grid &&
      Number.isInteger(grid.cols) &&
      Number.isInteger(grid.rows) &&
      grid.cols > 0 &&
      grid.rows > 0
      ? { ...grid }
      : null
  }

  private releasePin(ptyId: string): void {
    if (this.pinnedGrids.delete(ptyId)) {
      this.dependencies.onChange(ptyId, null)
    }
  }
}
