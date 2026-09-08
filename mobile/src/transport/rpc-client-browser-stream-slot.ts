// Why: only one browser.screencast stream may own the binary channel; a replacement
// must be parked until the server acknowledges it, or frames route to a dead listener.
export class RpcClientBrowserStreamSlot {
  private activeRequestId: string | null = null
  private pendingRequestId: string | null = null

  getActiveRequestId(): string | null {
    return this.activeRequestId
  }

  /** Returns the request ids this replacement supersedes. */
  replaceWith(id: string): string[] {
    const superseded = [this.activeRequestId, this.pendingRequestId].filter(
      (candidate): candidate is string => candidate !== null && candidate !== id
    )
    this.pendingRequestId = id
    this.activeRequestId = null
    return superseded
  }

  markPending(id: string): void {
    this.pendingRequestId = id
    this.activeRequestId = null
  }

  /** False when the server acknowledged a stream this client no longer wants. */
  acknowledge(id: string): boolean {
    if (this.pendingRequestId !== id && this.activeRequestId !== id) {
      return false
    }
    this.pendingRequestId = null
    this.activeRequestId = id
    return true
  }

  clear(id: string): void {
    if (this.activeRequestId === id) {
      this.activeRequestId = null
    }
    if (this.pendingRequestId === id) {
      this.pendingRequestId = null
    }
  }

  clearAll(): void {
    this.activeRequestId = null
    this.pendingRequestId = null
  }
}
