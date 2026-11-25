// Track registrations separately so each disposer removes only its own copy of a repeated listener.
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
