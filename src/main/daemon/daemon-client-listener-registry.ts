// Why: unsubscribe is by listener identity, so re-registering the same function
// twice yields two entries and each returned disposer drops only one of them.
export class DaemonClientListeners<T> {
  private listeners: T[] = []

  add(listener: T): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx !== -1) {
        this.listeners.splice(idx, 1)
      }
    }
  }

  each(visit: (listener: T) => void): void {
    for (const listener of this.listeners) {
      visit(listener)
    }
  }
}
