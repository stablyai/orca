type InFlightTerminalInventoryRequest = {
  allowEmptyLoaded: boolean
  promise: Promise<boolean>
  startedAt: number
}

export class MobileTerminalInventoryRequest {
  private activation: symbol | null = null
  private inFlight: InFlightTerminalInventoryRequest | null = null

  activate(): () => void {
    const activation = Symbol('terminal-inventory-activation')
    this.activation = activation
    return () => {
      if (this.activation === activation) {
        this.activation = null
      }
    }
  }

  run(
    allowEmptyLoaded: boolean,
    execute: (allowsEmpty: () => boolean, isCurrent: () => boolean) => Promise<boolean>,
    onPhysicalRequestStarted?: (startedAt: number) => void
  ): Promise<boolean> {
    if (this.inFlight) {
      this.inFlight.allowEmptyLoaded ||= allowEmptyLoaded
      onPhysicalRequestStarted?.(this.inFlight.startedAt)
      return this.inFlight.promise
    }
    const activation = this.activation
    const request: InFlightTerminalInventoryRequest = {
      allowEmptyLoaded,
      promise: Promise.resolve(false),
      startedAt: Date.now()
    }
    onPhysicalRequestStarted?.(request.startedAt)
    const execution = Promise.resolve().then(() =>
      execute(
        () => request.allowEmptyLoaded,
        () => activation !== null && this.activation === activation
      )
    )
    request.promise = execution.finally(() => {
      if (this.inFlight === request) {
        this.inFlight = null
      }
    })
    this.inFlight = request
    return request.promise
  }
}
