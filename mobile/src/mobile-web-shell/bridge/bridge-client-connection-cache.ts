import type { ConnectionState } from '../../transport/types'
import type { BridgeConnectionSnapshot } from './bridge-envelope'

export type BridgeSnapshotOutcome = 'applied' | 'stale' | 'unprimed'

// Prime from init before screens render synchronous RpcClient getters; guessing connecting before the first snapshot would change replay behavior.
export class BridgeConnectionCache {
  private held: BridgeConnectionSnapshot | null = null
  private readonly listeners = new Set<(state: ConnectionState) => void>()

  read(): BridgeConnectionSnapshot | null {
    return this.held
  }

  // Repriming identical state is not a transition and must notify nobody.
  prime(snapshot: BridgeConnectionSnapshot): void {
    const changed = this.held?.state !== snapshot.state
    this.held = snapshot
    if (changed) {
      this.fanOut(snapshot.state)
    }
  }

  // Reject backward generations: a client rebuild may publish older state before its init arrives, which would otherwise roll getters back to a dead client.
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

  // Close publishes disconnected but retains readable snapshots like native clients; throwing getters or missing transitions would leave the closing page connected.
  close(): void {
    const held = this.held
    if (held !== null && held.state !== 'disconnected') {
      this.held = { ...held, state: 'disconnected' }
      this.fanOut('disconnected')
    }
    this.listeners.clear()
  }

  // Set iteration tolerates listeners removing siblings during fan-out; avoid a copy.
  private fanOut(state: ConnectionState): void {
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
