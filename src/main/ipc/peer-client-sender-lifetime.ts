import type { WebContents } from 'electron'

// Why: a window reload or close never sends the explicit unsubscribe IPC, which
// would leave the upstream host streaming into a destroyed sender forever. One
// 'destroyed' listener per sender runs every still-registered cleanup.
export class PeerClientSenderLifetime {
  private readonly cleanupsBySender = new Map<WebContents, Map<string, () => void>>()
  private readonly senderByRequestId = new Map<string, WebContents>()

  bind(sender: WebContents, requestId: string, cleanup: () => void): void {
    let cleanups = this.cleanupsBySender.get(sender)
    if (!cleanups) {
      const created = new Map<string, () => void>()
      this.cleanupsBySender.set(sender, created)
      sender.once('destroyed', () => {
        this.cleanupsBySender.delete(sender)
        for (const [boundRequestId, run] of created) {
          this.senderByRequestId.delete(boundRequestId)
          run()
        }
      })
      cleanups = created
    }
    cleanups.set(requestId, cleanup)
    this.senderByRequestId.set(requestId, sender)
  }

  release(requestId: string): void {
    const sender = this.senderByRequestId.get(requestId)
    this.senderByRequestId.delete(requestId)
    if (sender) {
      this.cleanupsBySender.get(sender)?.delete(requestId)
    }
  }
}
