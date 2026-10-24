// Unit 6: per-socket FIFO delivery queue for MockOrcaServer (spec S6 "slow rpc"), split out of
// mock-orca-server.ts to keep that file under the line ceiling. Lets a delayed RPC response and
// the binary terminal frames pushed right after it (terminal.subscribe's snapshot) be chained in
// call order instead of racing ahead over the raw socket — the client's SubscriptionRegistry must
// see `subscribed` before any frame.
import type { MemorySocketLike } from './memory-socket-pair'

export class PerSocketSendQueue {
  private readonly tails = new Map<MemorySocketLike, Promise<void>>()

  /** Runs `run` after every earlier enqueue()'d send to `socket` has completed. When `delayMs`
   *  is >0 this step additionally waits delayMs before running — never compounded across items
   *  chained behind it (each waits only for the prior item to *finish*, not its own extra delay).
   *  The common case (delayMs 0, nothing pending) runs synchronously, matching pre-queue timing
   *  for callers that never opt into the "slow rpc" scenario. */
  enqueue(socket: MemorySocketLike, run: () => void, delayMs: number): void {
    const pending = this.tails.get(socket)
    if (!pending && delayMs === 0) {
      run()
      return
    }
    const prior = pending ?? Promise.resolve()
    const next = prior.then(
      () =>
        new Promise<void>((resolve) => {
          if (delayMs > 0) {
            setTimeout(() => {
              run()
              resolve()
            }, delayMs)
          } else {
            run()
            resolve()
          }
        })
    )
    this.tails.set(socket, next)
    void next.then(() => {
      if (this.tails.get(socket) === next) {
        this.tails.delete(socket)
      }
    })
  }

  /** Drops the queue tail for a closed/detached socket. */
  forget(socket: MemorySocketLike): void {
    this.tails.delete(socket)
  }
}
