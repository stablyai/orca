import {
  DispatcherClientWriter,
  type RelayClientSinkOptions,
  type RelayClientWrite
} from './dispatcher-client-writer'
import type { RelayClient } from './dispatcher-contract'
import { RelayDispatcherClientLifecycle } from './dispatcher-client-lifecycle'

export abstract class RelayDispatcherCapacitySignals extends RelayDispatcherClientLifecycle {
  onLegacyPtyCapacity(listener: () => void): () => void {
    this.legacyCapacityListeners.add(listener)
    return () => this.legacyCapacityListeners.delete(listener)
  }

  /**
   * Ungated per-client writer capacity, for a frame that lost control-lane admission and must retry.
   * onLegacyPtyCapacity cannot serve that: it is gated on producer retention, so it stays silent
   * exactly under the dual-queue pressure that rejected the frame. Registered on the dispatcher, not
   * the writer, so a retry survives setWrite() replacing the primary sink.
   * Returns null only when the client is gone for good. A merely closed client still counts: setWrite
   * marks the primary closed before replacing its sink, and that replacement is exactly when a frame
   * stranded by the old writer must be armed to retry.
   */
  onClientCapacity(clientId: number, listener: () => void): (() => void) | null {
    const client = this.clients.get(clientId)
    if (this.disposed || !client) {
      return null
    }
    const listeners = this.clientCapacityListeners.get(clientId) ?? new Set<() => void>()
    listeners.add(listener)
    this.clientCapacityListeners.set(clientId, listeners)
    return () => {
      const current = this.clientCapacityListeners.get(clientId)
      if (!current?.delete(listener) || current.size > 0) {
        return
      }
      this.clientCapacityListeners.delete(clientId)
    }
  }

  /**
   * Whether the id still names a client. A detach notification does not always mean it stopped:
   * invalidateClient() detaches the primary without removing it, and setWrite() revives that same id.
   */
  isClientAttached(clientId: number): boolean {
    return !this.disposed && this.clients.has(clientId)
  }

  canAdmitControlFrame(clientId: number, estimatedBytes: number): boolean {
    const client = this.clients.get(clientId)
    if (this.disposed || !client || client.closed) {
      return false
    }
    return client.writer.canEnqueueControl(estimatedBytes)
  }

  get legacyRetentionBelowLowWater(): boolean {
    return this.publicationLedger.belowLowWater(this.activeClientKeys())
  }

  /**
   * Same reserve as legacyRetentionBelowLowWater, but scoped to one client: a paced bulk producer
   * gated on the dispatcher-wide signal stops for a peer's stall and degrades a healthy link.
   * The relay-wide aggregate still counts — that ceiling is shared by every client.
   */
  producerRetentionBelowLowWater(clientId: number): boolean {
    const client = this.clients.get(clientId)
    if (!client || client.closed) {
      return false
    }
    return this.publicationLedger.belowLowWater([this.clientKey(client)])
  }

  writePrimaryBytes(data: Buffer, lane: 'control' | 'ordinary' = 'control'): boolean {
    if (this.disposed || this.primaryClient.closed) {
      return false
    }
    return this.primaryClient.writer.enqueue(lane, () => data, data.length)
  }

  protected activeClients(): RelayClient[] {
    return Array.from(this.clients.values()).filter((client) => !client.closed)
  }

  protected admitsPtyDataPublication(
    clientId: number,
    params: Readonly<Record<string, unknown>>
  ): boolean {
    return this.ptyDataPublicationAdmission?.(clientId, params) ?? true
  }

  protected activeClientKeys(): string[] {
    return this.activeClients().map((client) => this.clientKey(client))
  }

  protected clientKey(client: RelayClient): string {
    return `${client.id}:${client.generation}`
  }

  protected createWriter(
    client: RelayClient,
    write: RelayClientWrite,
    sinkOptions?: RelayClientSinkOptions
  ): DispatcherClientWriter {
    const writer = new DispatcherClientWriter(write, sinkOptions, (error) => {
      this.closeClient(client, error, client !== this.primaryClient)
    })
    writer.onCapacity(() => {
      this.notifyLegacyCapacityIfLow()
      this.notifyClientCapacity(client.id)
    })
    return writer
  }

  protected notifyClientCapacity(clientId: number): void {
    const listeners = this.clientCapacityListeners.get(clientId)
    if (!listeners?.size) {
      return
    }
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (err) {
        process.stderr.write(
          `[relay] Client capacity listener failed: ${err instanceof Error ? err.message : String(err)}\n`
        )
      }
    }
  }

  protected notifyLegacyCapacityIfLow(): void {
    this.notifyLegacyCapacity(false)
  }

  protected notifyLegacyCapacity(force: boolean): void {
    if (this.publicationTransactionDepth > 0) {
      this.deferredForcedLegacyCapacity ||= force
      this.deferredLegacyCapacity ||= !force
      return
    }
    if (!force && !this.publicationLedger.belowLowWater(this.activeClientKeys())) {
      return
    }
    for (const listener of this.legacyCapacityListeners) {
      listener()
    }
  }

  protected runPublicationTransaction<T>(operation: () => T): T {
    this.publicationTransactionDepth++
    try {
      return operation()
    } finally {
      this.publicationTransactionDepth--
      if (this.publicationTransactionDepth === 0) {
        const force = this.deferredForcedLegacyCapacity
        const low = this.deferredLegacyCapacity
        this.deferredForcedLegacyCapacity = false
        this.deferredLegacyCapacity = false
        if (force || low) {
          this.notifyLegacyCapacity(force)
        }
      }
    }
  }
}
