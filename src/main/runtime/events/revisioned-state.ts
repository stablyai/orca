// Publish revisioned changes; lifecycle policy remains with the owner.

/** Shared by states whose revisions one stream orders together. */
export type RevisionClock = { next(): number }

export function createRevisionClock(): RevisionClock {
  let last = 0
  return { next: () => ++last }
}

export class RevisionedState<S> {
  private revision = 0
  private readonly changed = new Set<() => void>()

  constructor(
    private value: S,
    private readonly clock?: RevisionClock
  ) {}

  get(): { value: S; revision: number } {
    return { value: this.value, revision: this.revision }
  }

  set(value: S): void {
    this.value = value
    this.revision = this.clock ? this.clock.next() : this.revision + 1
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
