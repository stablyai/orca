import { clampTerminalViewport } from './terminal-viewport'

type Viewport = { cols: number; rows: number }
type Viewer = Viewport & { clientId: string; activity: number }
type LayoutTarget =
  | ({ kind: 'desktop' } & Viewport)
  | ({ kind: 'remote-desktop'; ownerSubscriptionKey: string } & Viewport)

export type RemoteDesktopTerminalFloorDependencies = {
  isMobileDriven: (ptyId: string) => boolean
  getTerminalSize: (ptyId: string) => Viewport | null
  resolveHostTarget: (ptyId: string) => Viewport
  applyLayout: (ptyId: string, target: LayoutTarget) => Promise<{ ok: boolean }>
}

export class RemoteDesktopTerminalFloor {
  // Why: subscriptions, not clients, own floors so duplicate streams release independently.
  private readonly viewers = new Map<string, Map<string, Viewer>>()
  private readonly owners = new Map<string, string>()
  private readonly hostReclaimTargets = new Map<string, Viewport>()
  // Why: an in-flight host reclaim must not consume a target after a newer viewer mutation.
  private readonly viewerRevisions = new Map<string, number>()
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
    // Why: phone presence must not seed the separate remote-viewer cache.
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
    // Why: failed or superseded reclaim must retain true host geometry for the next attempt.
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
    if (claim) {
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
      (!claim || this.owners.get(ptyId) === subscriptionKey)
    ) {
      if (claim && this.owners.get(ptyId) === subscriptionKey) {
        const size = this.dependencies.getTerminalSize(ptyId)
        if (size?.cols !== viewport.cols || size.rows !== viewport.rows) {
          return this.applyLayout(ptyId)
        }
      }
      return true
    }
    const activity = claim ? ++this.activity : (prior?.activity ?? 0)
    viewers.set(subscriptionKey, { clientId, ...viewport, activity })
    this.bumpRevision(ptyId)
    if (claim) {
      this.owners.set(ptyId, subscriptionKey)
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
    this.owners.set(ptyId, subscriptionKey)
    this.bumpRevision(ptyId)
    return this.applyLayout(ptyId)
  }

  claimHost(ptyId: string, cols: number, rows: number): Promise<boolean> {
    if (!this.owners.has(ptyId)) {
      // Why: host input during an in-flight reclaim must join it, not pass it.
      return this.hostReclaimTargets.has(ptyId) ? this.applyLayout(ptyId) : Promise.resolve(true)
    }
    this.hostReclaimTargets.set(ptyId, clampTerminalViewport(cols, rows))
    this.owners.delete(ptyId)
    this.bumpRevision(ptyId)
    return this.applyLayout(ptyId)
  }

  unregisterViewers(ptyId: string, subscriptionKeys: Iterable<string>): Promise<boolean> {
    const viewers = this.viewers.get(ptyId)
    if (!viewers) {
      return Promise.resolve(false)
    }
    let changed = false
    let removedOwner = false
    for (const subscriptionKey of subscriptionKeys) {
      removedOwner = this.owners.get(ptyId) === subscriptionKey || removedOwner
      changed = viewers.delete(subscriptionKey) || changed
    }
    if (!changed) {
      return Promise.resolve(false)
    }
    if (viewers.size === 0) {
      this.viewers.delete(ptyId)
    }
    if (removedOwner) {
      let fallback: { key: string; activity: number } | null = null
      for (const [key, viewer] of viewers) {
        if (viewer.activity > 0 && (!fallback || viewer.activity > fallback.activity)) {
          fallback = { key, activity: viewer.activity }
        }
      }
      if (fallback) {
        this.owners.set(ptyId, fallback.key)
      } else {
        this.owners.delete(ptyId)
      }
    }
    this.bumpRevision(ptyId)
    return removedOwner ? this.applyLayout(ptyId) : Promise.resolve(true)
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
        this.owners.set(ptyId, subscriptionKey)
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

  private bumpRevision(ptyId: string): void {
    this.viewerRevisions.set(ptyId, (this.viewerRevisions.get(ptyId) ?? 0) + 1)
  }
}
