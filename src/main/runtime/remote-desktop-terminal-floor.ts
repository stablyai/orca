import { clampTerminalViewport } from '../../shared/terminal-viewport'

type Viewport = { cols: number; rows: number }
type Viewer = Viewport & { clientId: string; activity: number }
type LayoutTarget =
  | ({ kind: 'desktop' } & Viewport)
  | ({ kind: 'remote-desktop'; ownerSubscriptionKey: string } & Viewport)

export type RemoteDesktopTerminalFloorDependencies = {
  isMobileDriven: (ptyId: string) => boolean
  getTerminalSize: (ptyId: string) => Viewport | null
  resolveHostTarget: (ptyId: string) => Viewport
  /** False on a headless host (orca serve, orcad), which has no pane to give a PTY's grid back to. */
  hostShowsTerminals: () => boolean
  applyLayout: (ptyId: string, target: LayoutTarget) => Promise<{ ok: boolean }>
}

export class RemoteDesktopTerminalFloor {
  // Subscriptions own floors so duplicate streams clean up independently.
  private readonly viewers = new Map<string, Map<string, Viewer>>()
  private readonly owners = new Map<string, string>()
  private readonly hostReclaimTargets = new Map<string, Viewport>()
  // A newer viewer revision must prevent an older host reclaim consuming its target.
  private readonly viewerRevisions = new Map<string, number>()
  // Passively reconnecting clients resume reaped ownership unless another claim intervened.
  private readonly orphanedOwnerClientIds = new Map<string, string>()
  private activity = 0

  constructor(private readonly dependencies: RemoteDesktopTerminalFloorDependencies) {}

  ownerPtyIds(): Iterable<string> {
    return this.owners.keys()
  }

  hasViewers(ptyId: string): boolean {
    return (this.viewers.get(ptyId)?.size ?? 0) > 0
  }

  hasLayoutState(ptyId: string): boolean {
    return this.owners.has(ptyId) || this.hostReclaimTargets.has(ptyId)
  }

  hasHostReclaimTarget(ptyId: string): boolean {
    return this.hostReclaimTargets.has(ptyId)
  }

  isResizeDriven(ptyId: string): boolean {
    return this.owners.has(ptyId)
  }

  isViewerOwner(ptyId: string, subscriptionKey: string): boolean {
    return this.owners.get(ptyId) === subscriptionKey
  }

  getFitHold(
    ptyId: string,
    subscriptionKey: string
  ): { mode: 'remote-desktop-fit' | 'desktop-fit'; cols: number; rows: number } {
    return {
      mode: this.isViewerOwner(ptyId, subscriptionKey) ? 'desktop-fit' : 'remote-desktop-fit',
      ...(this.dependencies.getTerminalSize(ptyId) ?? { cols: 0, rows: 0 })
    }
  }

  recordHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    // Phone presence must not seed desktop-viewer reclaim geometry.
    if (!this.owners.has(ptyId) || cols <= 0 || rows <= 0) {
      return
    }
    this.hostReclaimTargets.set(ptyId, { cols, rows })
  }

  clearStaleHostReclaimTarget(ptyId: string): void {
    if (!this.hasViewers(ptyId)) {
      this.hostReclaimTargets.delete(ptyId)
    }
  }

  updateHostReclaimTarget(ptyId: string, cols: number, rows: number): void {
    if (this.hostReclaimTargets.has(ptyId)) {
      this.hostReclaimTargets.set(ptyId, { cols, rows })
    }
  }

  clearPty(ptyId: string): void {
    this.viewers.delete(ptyId)
    this.owners.delete(ptyId)
    this.hostReclaimTargets.delete(ptyId)
    this.viewerRevisions.delete(ptyId)
    this.orphanedOwnerClientIds.delete(ptyId)
  }

  async applyLayout(ptyId: string): Promise<boolean> {
    if (this.dependencies.isMobileDriven(ptyId)) {
      return true
    }
    const owner = this.owners.get(ptyId)
    const target = owner ? (this.viewers.get(ptyId)?.get(owner) ?? null) : null
    const reclaimingHost = !target
    const viewerRevision = this.viewerRevisions.get(ptyId) ?? 0
    const layoutTarget: LayoutTarget = target
      ? {
          kind: 'remote-desktop',
          cols: target.cols,
          rows: target.rows,
          ownerSubscriptionKey: owner!
        }
      : { kind: 'desktop', ...this.resolveHostReclaimTarget(ptyId) }
    const result = await this.dependencies.applyLayout(ptyId, layoutTarget)
    // Retain true host geometry after failed or superseded reclaim.
    if (
      reclaimingHost &&
      result.ok &&
      !this.owners.has(ptyId) &&
      this.viewerRevisions.get(ptyId) === viewerRevision
    ) {
      this.hostReclaimTargets.delete(ptyId)
    }
    return result.ok
  }

  async updateViewer(
    ptyId: string,
    subscriptionKey: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = true
  ): Promise<boolean> {
    const viewport = clampTerminalViewport(cols, rows)
    const claims =
      claim || (!this.owners.has(ptyId) && this.orphanedOwnerClientIds.get(ptyId) === clientId)
    if (claims) {
      this.ensureHostReclaimTarget(ptyId)
    }
    let viewers = this.viewers.get(ptyId)
    if (!viewers) {
      viewers = new Map()
      this.viewers.set(ptyId, viewers)
    }
    const prior = viewers.get(subscriptionKey)
    if (
      prior?.cols === viewport.cols &&
      prior.rows === viewport.rows &&
      (!claims || this.owners.get(ptyId) === subscriptionKey)
    ) {
      if (claims && this.owners.get(ptyId) === subscriptionKey) {
        const size = this.dependencies.getTerminalSize(ptyId)
        if (size?.cols !== viewport.cols || size.rows !== viewport.rows) {
          return this.applyLayout(ptyId)
        }
      }
      return true
    }
    const activity = claims ? ++this.activity : (prior?.activity ?? 0)
    viewers.set(subscriptionKey, { clientId, ...viewport, activity })
    this.bumpRevision(ptyId)
    if (claims) {
      this.setOwner(ptyId, subscriptionKey)
      return this.applyLayout(ptyId)
    }
    return true
  }

  claimViewer(ptyId: string, subscriptionKey: string): Promise<boolean> {
    const viewer = this.viewers.get(ptyId)?.get(subscriptionKey)
    if (!viewer) {
      return Promise.resolve(false)
    }
    if (this.owners.get(ptyId) === subscriptionKey) {
      const size = this.dependencies.getTerminalSize(ptyId)
      return size?.cols === viewer.cols && size.rows === viewer.rows
        ? Promise.resolve(true)
        : this.applyLayout(ptyId)
    }
    this.ensureHostReclaimTarget(ptyId)
    viewer.activity = ++this.activity
    this.setOwner(ptyId, subscriptionKey)
    this.bumpRevision(ptyId)
    return this.applyLayout(ptyId)
  }

  claimHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    this.orphanedOwnerClientIds.delete(ptyId)
    if (!this.owners.has(ptyId)) {
      // Host input must join an in-flight reclaim rather than overtake it.
      return this.hostReclaimTargets.has(ptyId) ? this.applyLayout(ptyId) : Promise.resolve(true)
    }
    this.hostReclaimTargets.set(ptyId, clampTerminalViewport(cols, rows))
    this.owners.delete(ptyId)
    this.bumpRevision(ptyId)
    return this.applyLayout(ptyId)
  }

  // Host typing cancels a reaped viewer's resume even without a visible fit override.
  noteHostInput(ptyId: string): void {
    this.orphanedOwnerClientIds.delete(ptyId)
  }

  unregisterViewers(ptyId: string, subscriptionKeys: Iterable<string>): Promise<boolean> {
    const viewers = this.viewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    let changed = false
    let removedOwnerClientId: string | null = null
    let removedOwnerViewport: Viewport | null = null
    for (const subscriptionKey of subscriptionKeys) {
      if (this.owners.get(ptyId) === subscriptionKey) {
        const owner = viewers.get(subscriptionKey)
        removedOwnerClientId = owner?.clientId ?? null
        removedOwnerViewport = owner ? { cols: owner.cols, rows: owner.rows } : null
      }
      changed = viewers.delete(subscriptionKey) || changed
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    if (viewers.size === 0) {
      this.viewers.delete(ptyId)
    }
    if (removedOwnerClientId !== null) {
      // A reconnect replacement stream from the same client retains ownership.
      let successor: { key: string; viewer: Viewer } | null = null
      let fallback: { key: string; activity: number } | null = null
      for (const [key, viewer] of viewers) {
        if (viewer.clientId === removedOwnerClientId) {
          successor = { key, viewer }
        } else if (viewer.activity > 0 && (!fallback || viewer.activity > fallback.activity)) {
          fallback = { key, activity: viewer.activity }
        }
      }
      if (successor) {
        successor.viewer.activity = ++this.activity
        this.setOwner(ptyId, successor.key)
      } else if (fallback) {
        this.setOwner(ptyId, fallback.key)
      } else {
        this.owners.delete(ptyId)
        this.orphanedOwnerClientIds.set(ptyId, removedOwnerClientId)
      }
    }
    this.bumpRevision(ptyId)
    if (removedOwnerClientId === null) {
      return Promise.resolve(true)
    }
    if (!this.owners.has(ptyId) && !this.dependencies.hostShowsTerminals()) {
      // Headless hosts have no host pane to reclaim; restoring spawn size would cause duplicate TUI redraws (#15997).
      if (removedOwnerViewport) {
        // Remember the departing viewer grid, not a temporary phone-fit grid, for the later restore.
        this.hostReclaimTargets.set(ptyId, removedOwnerViewport)
      }
      return Promise.resolve(true)
    }
    return this.applyLayout(ptyId)
  }

  refreshViewer(
    ptyId: string,
    clientId: string,
    cols: number,
    rows: number,
    claim = false
  ): Promise<boolean> {
    const viewers = this.viewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    const viewport = clampTerminalViewport(cols, rows)
    if (claim) {
      this.ensureHostReclaimTarget(ptyId)
    }
    let changed = false
    for (const [subscriptionKey, viewer] of viewers) {
      if (viewer.clientId !== clientId) {
        continue
      }
      const activity = claim ? ++this.activity : viewer.activity
      viewers.set(subscriptionKey, { ...viewer, ...viewport, activity })
      if (claim) {
        this.setOwner(ptyId, subscriptionKey)
      }
      changed = true
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    this.bumpRevision(ptyId)
    return this.owners.has(ptyId) ? this.applyLayout(ptyId) : Promise.resolve(true)
  }

  private resolveHostReclaimTarget(ptyId: string): Viewport {
    return this.hostReclaimTargets.get(ptyId) ?? this.dependencies.resolveHostTarget(ptyId)
  }

  private ensureHostReclaimTarget(ptyId: string): void {
    if (!this.hostReclaimTargets.has(ptyId)) {
      this.hostReclaimTargets.set(ptyId, this.resolveHostReclaimTarget(ptyId))
    }
  }

  private setOwner(ptyId: string, subscriptionKey: string): void {
    this.owners.set(ptyId, subscriptionKey)
    this.orphanedOwnerClientIds.delete(ptyId)
  }

  private bumpRevision(ptyId: string): void {
    this.viewerRevisions.set(ptyId, (this.viewerRevisions.get(ptyId) ?? 0) + 1)
  }
}
