import type { IPtyProvider, PtyProviderBufferSnapshot } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { sameDaemonIncarnation } from './daemon-session-route'

export class DaemonSnapshotAcknowledgementRoutes {
  private readonly producers = new Map<
    string,
    { adapter: DaemonPtyAdapter; incarnation: DaemonEndpointIdentity | null }
  >()
  private readonly pendingCaptures = new Map<
    string,
    {
      token: symbol
      adapter: DaemonPtyAdapter | undefined
      incarnation: DaemonEndpointIdentity | null
    }
  >()

  async capture(
    sessionId: string,
    opts: { scrollbackRows?: number } | undefined,
    provider: IPtyProvider,
    adapters: readonly DaemonPtyAdapter[]
  ): Promise<PtyProviderBufferSnapshot | null> {
    const producer = adapters.find((adapter) => adapter === provider)
    const before = producer?.getLastAuthenticatedDaemonIdentity() ?? null
    const token = Symbol(sessionId)
    this.pendingCaptures.set(sessionId, { token, adapter: producer, incarnation: before })
    try {
      const snapshot = (await provider.getBufferSnapshot?.(sessionId, opts)) ?? null
      if (this.pendingCaptures.get(sessionId)?.token !== token) {
        return snapshot
      }
      const incarnation = producer?.getLastAuthenticatedDaemonIdentity() ?? null
      if (before && !sameDaemonIncarnation(before, incarnation)) {
        this.producers.delete(sessionId)
        return snapshot
      }
      this.record(sessionId, snapshot, producer, incarnation)
      return snapshot
    } finally {
      if (this.pendingCaptures.get(sessionId)?.token === token) {
        this.pendingCaptures.delete(sessionId)
      }
    }
  }

  private record(
    sessionId: string,
    snapshot: PtyProviderBufferSnapshot | null,
    producer: DaemonPtyAdapter | undefined,
    incarnation: DaemonEndpointIdentity | null
  ): void {
    if (snapshot && producer) {
      this.producers.set(sessionId, {
        adapter: producer,
        incarnation
      })
    } else {
      this.producers.delete(sessionId)
    }
  }

  dropForProducer(
    sessionId: string,
    adapter: DaemonPtyAdapter,
    incarnation = adapter.getLastAuthenticatedDaemonIdentity()
  ): void {
    const producer = this.producers.get(sessionId)
    if (producer?.adapter === adapter && sameDaemonIncarnation(producer.incarnation, incarnation)) {
      this.producers.delete(sessionId)
    }
    const pending = this.pendingCaptures.get(sessionId)
    if (pending?.adapter === adapter && sameDaemonIncarnation(pending.incarnation, incarnation)) {
      this.pendingCaptures.delete(sessionId)
    }
  }

  dropAdapterIncarnation(
    adapter: DaemonPtyAdapter,
    incarnation: DaemonEndpointIdentity | null
  ): void {
    for (const [sessionId, producer] of this.producers) {
      if (
        producer.adapter === adapter &&
        sameDaemonIncarnation(producer.incarnation, incarnation)
      ) {
        this.producers.delete(sessionId)
      }
    }
    for (const [sessionId, pending] of this.pendingCaptures) {
      if (pending.adapter === adapter && sameDaemonIncarnation(pending.incarnation, incarnation)) {
        this.pendingCaptures.delete(sessionId)
      }
    }
  }

  acknowledge(sessionId: string): void {
    const producer = this.producers.get(sessionId)
    this.producers.delete(sessionId)
    if (
      producer &&
      sameDaemonIncarnation(
        producer.incarnation,
        producer.adapter.getLastAuthenticatedDaemonIdentity()
      )
    ) {
      producer.adapter.ackColdRestore(sessionId)
    }
  }

  clear(): void {
    this.producers.clear()
    this.pendingCaptures.clear()
  }
}
