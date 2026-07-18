export class SerializedOperationQueue {
  private tail: Promise<void> = Promise.resolve()

  wait(): Promise<void> {
    return this.tail
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  reset(): void {
    this.tail = Promise.resolve()
  }
}
