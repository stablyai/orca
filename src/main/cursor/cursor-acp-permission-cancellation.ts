/** One transport-owned cancellation signal per prompt turn; prompt claims remain in the registry. */
export class CursorAcpPermissionCancellation {
  private controller = new AbortController()

  get signal(): AbortSignal {
    return this.controller.signal
  }

  beginTurn(): void {
    this.controller = new AbortController()
  }

  cancel(): void {
    this.controller.abort()
  }
}
