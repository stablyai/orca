import type { ConnectionState } from '../../transport/types'
import { BridgeClientNotReadyError } from './bridge-client-errors'
import type {
  BridgeConnectionPathSource,
  BridgeConnectionSnapshot
} from './bridge-connection-snapshot'

export type BridgeSnapshotOutcome = 'applied' | 'stale' | 'unprimed'

// Prime from init before screens render synchronous RpcClient getters; guessing connecting before the first snapshot would change replay behavior.
export class BridgeConnectionCache {
  private held: BridgeConnectionSnapshot | null = null
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private readonly pathListeners = new Set<() => void>()

  read(): BridgeConnectionSnapshot | null {
    return this.held
  }

  // Getters run only after init primed the cache; reading earlier is a page bug, not a disconnect.
  require(): BridgeConnectionSnapshot {
    if (this.held === null) {
      throw new BridgeClientNotReadyError()
    }
    return this.held
  }

  // Older shells send no path; relay with nothing pending is what pages assumed before they did.
  pathSource(): BridgeConnectionPathSource {
    return {
      getActivePath: () => this.require().activePath ?? 'relay',
      getPendingPath: () => this.require().pendingPath ?? null,
      getRelayHostReachability: () => this.require().relayHostReachability ?? 'connecting',
      onConnectionPathChange: (listener) => this.onPathChange(listener)
    }
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
    const outcome = this.hold(snapshot)
    if (outcome === 'applied') {
      this.fanOut(snapshot.state)
    }
    return outcome
  }

  // A path-only change is not a transition: state listeners would read it as one and re-run.
  applyPath(snapshot: BridgeConnectionSnapshot): BridgeSnapshotOutcome {
    const outcome = this.hold(snapshot)
    if (outcome === 'applied') {
      for (const listener of this.pathListeners) {
        listener()
      }
    }
    return outcome
  }

  onPathChange(listener: () => void): () => void {
    this.pathListeners.add(listener)
    return () => {
      this.pathListeners.delete(listener)
    }
  }

  private hold(snapshot: BridgeConnectionSnapshot): BridgeSnapshotOutcome {
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
    this.pathListeners.clear()
  }

  // Set iteration tolerates listeners removing siblings during fan-out; avoid a copy.
  private fanOut(state: ConnectionState): void {
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}
