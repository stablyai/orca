import type { ConnectionState } from '../../transport/types'
import type { BridgeConnectionSnapshot } from './bridge-envelope'

/** Why a `state` frame did not land. `unprimed` is a frame that beat `init`, `stale` one that lost to it. */
export type BridgeSnapshotOutcome = 'applied' | 'stale' | 'unprimed'

/**
 * What the page's synchronous `RpcClient` getters read.
 *
 * Screens read `getState()` during render, so the answer has to already be here when the first one
 * mounts: `init` primes it, every `state` refreshes it, and nothing is ever derived or guessed. A
 * cache that answered `connecting` because it had not heard yet would move a golden.
 */
export class BridgeConnectionCache {
  private held: BridgeConnectionSnapshot | null = null
  private readonly listeners = new Set<(state: ConnectionState) => void>()

  read(): BridgeConnectionSnapshot | null {
    return this.held
  }

  /** From `init`. Re-priming with the same state is not a transition, so no listener hears one. */
  prime(snapshot: BridgeConnectionSnapshot): void {
    const changed = this.held?.state !== snapshot.state
    this.held = snapshot
    if (changed) {
      this.fanOut(snapshot.state)
    }
  }

  /**
   * From `state`, one frame per transition on the shell's side, so every accepted one is fanned out.
   *
   * A snapshot whose generation went backwards is refused: the shell was rebuilt over a newer
   * client and the page missed the `init` that would have said so, which makes what the page holds
   * newer than what just arrived. Applying it would walk the cache backwards and leave every getter
   * answering for a client that no longer exists.
   */
  apply(snapshot: BridgeConnectionSnapshot): BridgeSnapshotOutcome {
    const previous = this.held
    if (previous === null) {
      return 'unprimed'
    }
    if (
      previous.generation !== null &&
      snapshot.generation !== null &&
      snapshot.generation < previous.generation
    ) {
      return 'stale'
    }
    this.held = snapshot
    this.fanOut(snapshot.state)
    return 'applied'
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The page said goodbye. Every native client publishes `disconnected` when it closes and keeps
   * answering its last snapshot afterwards, and the screens above this one are written to that: a
   * getter that threw here, or a listener that never heard the transition, would leave a closing
   * page rendering a dot that is still connected.
   */
  close(): void {
    const held = this.held
    if (held !== null && held.state !== 'disconnected') {
      this.held = { ...held, state: 'disconnected' }
      this.fanOut('disconnected')
    }
    this.listeners.clear()
  }

  // Walked in place: a listener that unsubscribes a sibling during the fan-out is what a `Set`
  // iterator is specified to survive.
  private fanOut(state: ConnectionState): void {
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
