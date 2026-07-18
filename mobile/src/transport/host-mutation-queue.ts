export class HostMutationQueue {
  private tail: Promise<void> = Promise.resolve()

  settled(): Promise<void> {
    return this.tail
  }

  enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(mutation)
    this.tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  resetForTests(): void {
    this.tail = Promise.resolve()
  }
}
