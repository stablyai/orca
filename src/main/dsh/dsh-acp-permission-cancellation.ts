/** One transport-owned cancellation signal per prompt turn; prompt claims remain in the registry. */
export class DshAcpPermissionCancellation {
  private controller = new AbortController()

  constructor() {
    this.controller.abort()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  beginTurn(): void {
    this.controller.abort()
    this.controller = new AbortController()
  }

  cancel(): void {
    this.controller.abort()
  }
}
