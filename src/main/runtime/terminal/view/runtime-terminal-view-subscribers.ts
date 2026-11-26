type RuntimeTerminalViewSubscriberDependencies = {
  notifyPresenceChanged: (ptyId: string) => void
  hasMobileSubscribers: (ptyId: string) => boolean
  ensureProviderAttach: (ptyId: string) => void
}

type SilenceableRemoteView = { isSilent: () => boolean }
/** Only views that report when their pane is hidden can claim to be on screen. */
type PaneReportingRemoteView = { isHidden: () => boolean }

export class RuntimeTerminalViewSubscribers {
  private readonly remoteCounts = new Map<string, number>()
  private readonly silenceableRemoteViews = new Map<string, Set<SilenceableRemoteView>>()
  private readonly rawCounts = new Map<string, number>()
  private readonly paneReportingRemoteViews = new Map<string, Set<PaneReportingRemoteView>>()
  /** Remote views whose client would show a dead pane if the host replaced its terminal; a token
   *  per view, so a release from before `clearSubscribers` cannot drop a later view. */
  private readonly respawnBlindViews = new Map<string, Set<symbol>>()

  constructor(private readonly deps: RuntimeTerminalViewSubscriberDependencies) {}

  clearSubscribers(ptyId: string): void {
    this.remoteCounts.delete(ptyId)
    this.silenceableRemoteViews.delete(ptyId)
    this.rawCounts.delete(ptyId)
    this.paneReportingRemoteViews.delete(ptyId)
    this.respawnBlindViews.delete(ptyId)
  }

  registerRemote(
    ptyId: string,
    isSilent?: () => boolean,
    isHidden?: () => boolean,
    followsHostRespawn = false
  ): () => void {
    this.remoteCounts.set(ptyId, (this.remoteCounts.get(ptyId) ?? 0) + 1)
    const blindView = followsHostRespawn ? null : Symbol(ptyId)
    if (blindView) {
      const views = this.respawnBlindViews.get(ptyId) ?? new Set()
      views.add(blindView)
      this.respawnBlindViews.set(ptyId, views)
    }
    const view = isSilent ? { isSilent } : null
    if (view) {
      const views = this.silenceableRemoteViews.get(ptyId) ?? new Set()
      views.add(view)
      this.silenceableRemoteViews.set(ptyId, views)
    }
    const paneView = isHidden ? { isHidden } : null
    if (paneView) {
      const views = this.paneReportingRemoteViews.get(ptyId) ?? new Set()
      views.add(paneView)
      this.paneReportingRemoteViews.set(ptyId, views)
    }
    this.deps.ensureProviderAttach(ptyId)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      this.decrement(this.remoteCounts, ptyId)
      const blindViews = this.respawnBlindViews.get(ptyId)
      if (blindView && blindViews?.delete(blindView) && blindViews.size === 0) {
        this.respawnBlindViews.delete(ptyId)
      }
      const views = this.silenceableRemoteViews.get(ptyId)
      if (view && views?.delete(view) && views.size === 0) {
        this.silenceableRemoteViews.delete(ptyId)
      }
      const paneViews = this.paneReportingRemoteViews.get(ptyId)
      if (paneView && paneViews?.delete(paneView) && paneViews.size === 0) {
        this.paneReportingRemoteViews.delete(ptyId)
      }
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  /** No remote view of this PTY would be left on a dead pane if the host replaced its terminal. */
  everyRemoteViewFollowsHostRespawn(ptyId: string): boolean {
    return !this.respawnBlindViews.has(ptyId)
  }

  /** A remote client is displaying this PTY's pane right now. */
  isShownRemotely(ptyId: string): boolean {
    for (const view of this.paneReportingRemoteViews.get(ptyId) ?? []) {
      if (!view.isHidden()) {
        return true
      }
    }
    return false
  }

  /** A remote view could be displaying this PTY: one is on screen, or one cannot report a hidden pane. */
  mayBeShownRemotely(ptyId: string): boolean {
    const paneReporting = this.paneReportingRemoteViews.get(ptyId)?.size ?? 0
    return (
      this.isShownRemotely(ptyId) ||
      (this.remoteCounts.get(ptyId) ?? 0) > paneReporting ||
      this.deps.hasMobileSubscribers(ptyId)
    )
  }

  registerRaw(ptyId: string): () => void {
    this.rawCounts.set(ptyId, (this.rawCounts.get(ptyId) ?? 0) + 1)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      this.decrement(this.rawCounts, ptyId)
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  hasRaw(ptyId: string): boolean {
    return (this.rawCounts.get(ptyId) ?? 0) > 0 || this.hasRemote(ptyId)
  }

  hasRemote(ptyId: string): boolean {
    return (this.remoteCounts.get(ptyId) ?? 0) > 0 || this.deps.hasMobileSubscribers(ptyId)
  }

  /** A remote view answering queries now; silent views leave them to main. */
  hasRemoteAnsweringQueries(ptyId: string): boolean {
    return this.remoteAnsweringQueriesCount(ptyId) > 0
  }

  remoteAnsweringQueriesCount(ptyId: string): number {
    let silent = 0
    for (const view of this.silenceableRemoteViews.get(ptyId) ?? []) {
      if (view.isSilent()) {
        silent += 1
      }
    }
    return (this.remoteCounts.get(ptyId) ?? 0) - silent
  }

  private decrement(counts: Map<string, number>, ptyId: string): void {
    const next = (counts.get(ptyId) ?? 1) - 1
    if (next <= 0) {
      counts.delete(ptyId)
    } else {
      counts.set(ptyId, next)
    }
  }

  private releaseOnce(release: () => void): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      release()
    }
  }
}
