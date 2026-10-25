// Publish revisioned changes; lifecycle policy remains with the owner.

export class RevisionedState<S> {
  private revision = 0
  private readonly changed = new Set<() => void>()

  constructor(private value: S) {}

  get(): { value: S; revision: number } {
    return { value: this.value, revision: this.revision }
  }

  set(value: S): void {
    this.value = value
    this.revision += 1
    this.changed.forEach((notify) => notify())
  }

  /** Calls `onChange` after every set until the returned unsubscribe. */
  subscribe(onChange: () => void): () => void {
    this.changed.add(onChange)
    return () => {
      this.changed.delete(onChange)
    }
  }
}
