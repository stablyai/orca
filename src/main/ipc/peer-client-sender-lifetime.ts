import type { WebContents } from 'electron'

// Why: a window reload or close never sends the explicit unsubscribe IPC, which
// would leave the upstream host streaming into a destroyed sender forever. One
// 'destroyed' listener per sender runs every still-registered cleanup.
export class PeerClientSenderLifetime {
  private readonly senderCleanups = new Map<WebContents, Set<() => void>>()
  private readonly releasesByRequestId = new Map<string, () => void>()

  bind(sender: WebContents, requestId: string, cleanup: () => void): void {
    let cleanups = this.senderCleanups.get(sender)
    if (!cleanups) {
      const created = new Set<() => void>()
      this.senderCleanups.set(sender, created)
      sender.once('destroyed', () => {
        this.senderCleanups.delete(sender)
        for (const run of created) {
          run()
        }
      })
      cleanups = created
    }
    cleanups.add(cleanup)
    this.releasesByRequestId.set(requestId, () => {
      this.senderCleanups.get(sender)?.delete(cleanup)
      this.releasesByRequestId.delete(requestId)
    })
  }

  release(requestId: string): void {
    this.releasesByRequestId.get(requestId)?.()
  }
}
