export class CdpSyntheticSessionRegistry {
  // agent-browser filters events by its Target.attachToTarget session ID.
  private clientSessionId: string | undefined = undefined
  private screencastSessionId: string | undefined = undefined
  private readonly clientSessionIds = new Set<string>()
  private readonly clientBrowserSessionIds = new Set<string>()
  private nextClientSessionOrdinal = 0
  private nextClientBrowserSessionOrdinal = 0
  private screencastDetachListener: (() => void) | null = null

  clear(): void {
    this.clientSessionId = undefined
    this.screencastSessionId = undefined
    this.clientSessionIds.clear()
    this.clientBrowserSessionIds.clear()
    this.nextClientSessionOrdinal = 0
    this.nextClientBrowserSessionOrdinal = 0
  }

  attachPageSession(): string {
    const sessionId = this.nextSyntheticPageSessionId()
    this.clientSessionIds.add(sessionId)
    this.clientSessionId ??= sessionId
    return sessionId
  }

  attachBrowserSession(): string {
    // Playwright attaches a distinct browser session before attaching the page.
    const sessionId = this.nextSyntheticBrowserSessionId()
    this.clientBrowserSessionIds.add(sessionId)
    return sessionId
  }

  detachSession(detachedSessionId: unknown): void {
    if (typeof detachedSessionId === 'string') {
      this.clientSessionIds.delete(detachedSessionId)
      this.clientBrowserSessionIds.delete(detachedSessionId)
      if (detachedSessionId === this.clientSessionId) {
        this.clientSessionId = this.clientSessionIds.values().next().value
      }
      if (detachedSessionId === this.screencastSessionId) {
        this.screencastSessionId = undefined
        this.screencastDetachListener?.()
      }
    }
  }

  onScreencastSessionDetached(listener: () => void): void {
    this.screencastDetachListener = listener
  }

  routeScreencastEventsTo(msgSessionId: string | undefined): void {
    this.screencastSessionId =
      msgSessionId && this.clientSessionIds.has(msgSessionId) ? msgSessionId : undefined
  }

  rootEventSessionId(method: string): string | undefined {
    if (this.screencastSessionId && method.startsWith('Page.screencast')) {
      return this.screencastSessionId
    }
    return this.clientSessionId
  }

  resolveDebuggerSessionId(msgSessionId?: string): string | undefined {
    const syntheticSession =
      (msgSessionId && this.clientSessionIds.has(msgSessionId)) ||
      (msgSessionId && this.clientBrowserSessionIds.has(msgSessionId))
    return msgSessionId && !syntheticSession ? msgSessionId : undefined
  }

  private nextSyntheticPageSessionId(): string {
    this.nextClientSessionOrdinal += 1
    return this.nextClientSessionOrdinal === 1
      ? 'orca-proxy-session'
      : `orca-proxy-session-${this.nextClientSessionOrdinal}`
  }

  private nextSyntheticBrowserSessionId(): string {
    this.nextClientBrowserSessionOrdinal += 1
    return this.nextClientBrowserSessionOrdinal === 1
      ? 'orca-proxy-browser-session'
      : `orca-proxy-browser-session-${this.nextClientBrowserSessionOrdinal}`
  }
}
