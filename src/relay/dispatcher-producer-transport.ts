import {
  DEFAULT_PRODUCER_QUEUE_MAX_BYTES,
  type SinkWriteSettlement
} from './dispatcher-client-writer'
import type { LegacyPublicationLease } from './legacy-relay-publication-ledger'
import type { JsonRpcNotification } from './protocol'
import type { PreparedRelayFrame, RelayClient } from './dispatcher-contract'
import { RelayDispatcherRpcRouting } from './dispatcher-rpc-routing'

export abstract class RelayDispatcherProducerTransport extends RelayDispatcherRpcRouting {
  protected tryPublishToClients(
    clients: readonly RelayClient[],
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary' | 'bulk'
  ): boolean {
    return this.runPublicationTransaction(() => {
      if (clients.length === 0) {
        return true
      }
      const frame = this.prepareFrame(msg)
      const bytes = frame.frameBytes
      if (clients.some((client) => !client.writer.canEnqueueProducer(bytes))) {
        return false
      }
      const leases = this.publicationLedger.tryReserve(
        clients.map((client) => ({ clientKey: this.clientKey(client), bytes }))
      )
      if (!leases) {
        return false
      }
      for (let index = 0; index < clients.length; index++) {
        if (!this.enqueueLeasedFrame(clients[index], frame, lane, leases[index])) {
          if (this.disposed || clients[index].closed) {
            continue
          }
          for (let remaining = index; remaining < leases.length; remaining++) {
            leases[remaining].release()
          }
          return false
        }
      }
      return true
    })
  }

  protected projectToClients(
    clients: readonly RelayClient[],
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary'
  ): boolean {
    return this.runPublicationTransaction(() => {
      if (clients.length === 0) {
        return true
      }
      const frame = this.prepareFrame(msg)
      for (const client of clients) {
        if (client.closed || this.publishPreparedToClient(client, frame, lane)) {
          continue
        }
        this.closeClient(
          client,
          new Error('Relay PTY subscriber projection capacity exceeded'),
          client !== this.primaryClient
        )
      }
      return !this.disposed
    })
  }

  protected publishToClient(
    client: RelayClient,
    msg: JsonRpcNotification,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    if (this.disposed || client.closed) {
      return false
    }
    return this.publishPreparedToClient(client, this.prepareFrame(msg), lane, onSettled)
  }

  protected publishPreparedToClient(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const bytes = frame.frameBytes
    const fixedBlocked =
      lane === 'fixed-bulk' &&
      (client.writer.retainedProducerBytes > 0 || bytes > client.writer.fixedFrameCapacity)
    if (fixedBlocked || (lane !== 'fixed-bulk' && !client.writer.canEnqueueProducer(bytes))) {
      return false
    }
    const leases = this.publicationLedger.tryReserve([{ clientKey: this.clientKey(client), bytes }])
    if (!leases) {
      return false
    }
    return this.enqueueLeasedFrame(client, frame, lane, leases[0], onSettled)
  }

  protected publishBulkWhenAvailable(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'fixed-bulk' | 'bulk'
  ): Promise<void> {
    const bytes = frame.frameBytes
    if (bytes > DEFAULT_PRODUCER_QUEUE_MAX_BYTES) {
      return Promise.reject(new Error('Relay bulk frame exceeds sink producer capacity'))
    }
    if (lane === 'bulk' && bytes > client.writer.producerFrameCapacity) {
      return Promise.reject(new Error('Relay bulk frame exceeds sink frame capacity'))
    }
    return new Promise<void>((resolve, reject) => {
      let removeCapacityListener: (() => void) | null = null
      const finish = (): void => {
        removeCapacityListener?.()
        removeCapacityListener = null
      }
      const tryPublish = (): void => {
        if (this.disposed || client.closed) {
          finish()
          resolve()
          return
        }
        if (
          this.publishPreparedToClient(client, frame, lane, (result) => {
            finish()
            if (result.ok || this.disposed || client.closed) {
              resolve()
            } else {
              reject(result.error)
            }
          })
        ) {
          return
        }
        if (!removeCapacityListener) {
          removeCapacityListener = this.onLegacyPtyCapacity(tryPublish)
        }
      }
      tryPublish()
    })
  }

  protected enqueueLeasedFrame(
    client: RelayClient,
    frame: PreparedRelayFrame,
    lane: 'interactive' | 'ordinary' | 'fixed-bulk' | 'bulk',
    lease: LegacyPublicationLease,
    onSettled: (result: SinkWriteSettlement) => void = () => {}
  ): boolean {
    const accepted = this.enqueuePreparedFrame(client, frame, lane, (result) => {
      lease.release()
      onSettled(result)
      this.notifyLegacyCapacityIfLow()
    })
    if (!accepted) {
      lease.release()
      this.notifyLegacyCapacityIfLow()
    }
    return accepted
  }
}
