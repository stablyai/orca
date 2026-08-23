const MAX_IN_FLIGHT_ADOPTIONS = 4_096

export class StructuredTuiAdoptionInflight<Result> {
  private readonly operations = new Map<string, Promise<Result>>()

  run(
    input: { callerKey: string; operationId: string; fingerprint: string },
    adopt: () => Promise<Result>
  ): Promise<Result> {
    const key = `${input.callerKey}\0${input.operationId}\0${input.fingerprint}`
    const existing = this.operations.get(key)
    if (existing) {
      return existing
    }
    if (this.operations.size >= MAX_IN_FLIGHT_ADOPTIONS) {
      return Promise.reject(new Error('Too many structured TUI adoptions are still pending.'))
    }
    const operation = adopt()
    this.operations.set(key, operation)
    const drop = (): void => {
      if (this.operations.get(key) === operation) {
        this.operations.delete(key)
      }
    }
    void operation.then(drop, drop)
    return operation
  }
}
