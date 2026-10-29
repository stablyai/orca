export class CdpSyntheticSessionRegistry {
  // agent-browser filters events by its Target.attachToTarget session ID.
  private clientSessionId: string | undefined = undefined
  private readonly clientSessionIds = new Set<string>()
  private readonly clientBrowserSessionIds = new Set<string>()
  private nextClientSessionOrdinal = 0
  private nextClientBrowserSessionOrdinal = 0

  get primarySessionId(): string | undefined {
    return this.clientSessionId
  }

  clear(): void {
    this.clientSessionId = undefined
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
    }
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
