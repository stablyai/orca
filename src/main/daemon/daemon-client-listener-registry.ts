import { addRemovableListener } from './add-removable-listener'

// Why: unsubscribe is by listener identity, so re-registering the same function
// twice yields two entries and each returned disposer drops only one of them.
export class DaemonClientListeners<T> {
  private listeners: T[] = []

  add(listener: T): () => void {
    return addRemovableListener(this.listeners, listener)
  }

  each(visit: (listener: T) => void): void {
    for (const listener of this.listeners) {
      visit(listener)
    }
  }
}
