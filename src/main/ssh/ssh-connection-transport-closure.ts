/**
 * One-shot subscribers told when every transport resource a connection allocated has physically
 * closed and its tracked work has drained. That is local lifetime evidence only: it never proves a
 * remote process exited.
 */
export class SshTransportClosureSubscribers {
  private readonly subscribers = new Set<() => void>()

  constructor(private readonly isPhysicallyClosed: () => boolean) {}

  subscribe(onClosed: () => void): () => void {
    this.subscribers.add(onClosed)
    this.notify()
    return () => {
      this.subscribers.delete(onClosed)
    }
  }

  notify(): void {
    if (!this.subscribers.size || !this.isPhysicallyClosed()) {
      return
    }
    const subscribers = [...this.subscribers]
    this.subscribers.clear()
    for (const onClosed of subscribers) {
      try {
        onClosed()
      } catch {
        // Observers must not interrupt physical transport cleanup.
      }
    }
  }
}
