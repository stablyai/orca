import { createDaemonTransientSink } from './daemon-transient-sink'
import {
  flushDaemonStreamBatch,
  SHALLOW_SOCKET_WRITE_GATE_BYTES
} from './daemon-stream-batch-flush'
import type { Socket } from 'node:net'
import { NDJSON_MAX_LINE_BYTES } from './ndjson'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import {
  accountDaemonStreamEntry,
  discardDaemonStreamEntry,
  releaseDaemonStreamEntry
} from './daemon-stream-entry-accounting'
import { DaemonStreamHeldRefill } from './daemon-stream-held-refill'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { DaemonEvent } from './types'
import { appendDaemonStreamData, type DaemonStreamEnqueueOptions } from './daemon-stream-data-entry'
import {
  evaluateDroppableEnqueue,
  refreshDroppableSessionMembership
} from './daemon-stream-droppable-membership'
import type { DaemonStreamDataBatcherOptions } from './daemon-stream-data-batcher-options'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { TerminalTransientSink } from '../../shared/terminal-transient-observation'

// Resolve framing at flush time so replacement streams use their own negotiated format.
type StreamDataClient = Pick<ConnectedDaemonClient, 'streamSocket' | 'streamFraming'>

// Both daemon and main batch output; a short interval limits their combined echo delay.
const STREAM_DATA_BATCH_INTERVAL_MS = 2

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number
  private readonly backpressure: DaemonStreamBackpressure | undefined
  private readonly heldRefill = new DaemonStreamHeldRefill((clientId) => this.flush(clientId))
  private isSessionDroppable: (sessionId: string) => boolean
  private salvageDroppedData: (
    dropped: string,
    maxChars: number,
    end?: number,
    accept?: (chars: number) => boolean
  ) => string
  prepareTransients(
    clientId: string,
    sessionId: string
  ): (() => TerminalTransientSink | undefined) | null {
    const socket = this.getClient(clientId)?.streamSocket
    if (!socket || socket.destroyed) {
      return null
    }
    return () =>
      this.getClient(clientId)?.streamSocket === socket && !socket.destroyed
        ? this.bindTransients(clientId, sessionId)
        : undefined
  }

  bindTransients(clientId: string, sessionId: string): TerminalTransientSink | undefined {
    const socket = this.getClient(clientId)?.streamSocket
    if (!socket || socket.destroyed) {
      return undefined
    }
    return createDaemonTransientSink(
      {
        socket,
        isCurrent: () => this.getClient(clientId)?.streamSocket === socket,
        getBatch: () => this.getOrCreateBatch(clientId),
        getPendingBatch: () => this.pendingByClient.get(clientId),
        removeSnapshot: (batch) => this.removeSnapshot(batch, sessionId),
        updateBackpressure: (batch) => this.updateBackpressure(clientId, batch),
        scheduleFlush: (batch) => {
          if (!batch.timer) {
            batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
          }
        }
      },
      sessionId
    )
  }

  private removeSnapshot(
    batch: PendingStreamDataBatch | undefined,
    sessionId?: string,
    incarnationId?: string,
    installations = false
  ): void {
    if (batch) {
      if (sessionId !== undefined) {
        const snapshot = batch.latestSnapshots?.get(sessionId)
        if (snapshot && batch.queue.at(-1) === snapshot) {
          batch.queue.pop()
          releaseDaemonStreamEntry(batch, snapshot)
        } else {
          discardDaemonStreamEntry(batch, snapshot)
        }
        return
      }
      batch.queue = batch.queue.filter((entry) => {
        if (entry.discarded) {
          return false
        }
        const observation =
          entry.observation ??
          (installations && entry.control?.event === 'terminalObservation'
            ? entry.control
            : undefined)
        if (
          !observation ||
          (sessionId !== undefined && entry.sessionId !== sessionId) ||
          (incarnationId !== undefined && observation.incarnationId !== incarnationId)
        ) {
          return true
        }
        releaseDaemonStreamEntry(batch, entry)
        return false
      })
      batch.discardedEntries = 0
    }
  }

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    const isBackgroundDroppable = options.isSessionDroppable ?? (() => false)
    // Keep-tail dropping also lets stalled foreground producers run past unreachable consumers.
    this.isSessionDroppable = (sessionId) =>
      this.backpressure?.isStallReleased(sessionId) === true || isBackgroundDroppable(sessionId)
    this.salvageDroppedData = options.salvageDroppedData ?? (() => '')
    this.backpressure = options.onProducerBackpressureChanged
      ? new DaemonStreamBackpressure(
          options.onProducerBackpressureChanged,
          this.isSessionDroppable,
          options.isSessionAttachedToClient,
          (sessionId) => this.refreshSessionDroppability(sessionId)
        )
      : undefined
  }

  enqueue(
    clientId: string,
    sessionId: string,
    data: string,
    options: DaemonStreamEnqueueOptions = {}
  ): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    const batch = this.getOrCreateBatch(clientId)
    this.removeSnapshot(batch, sessionId)
    const queuedAfter = appendDaemonStreamData(batch, sessionId, data, options)
    const queuedBefore = queuedAfter - data.length
    evaluateDroppableEnqueue(
      batch,
      sessionId,
      queuedBefore,
      queuedAfter,
      this.isSessionDroppable,
      this.salvageDroppedData
    )
    this.updateBackpressure(clientId, batch)

    if (
      options.flushImmediately === true &&
      (!batch.droppableQueuedSessionIds.has(sessionId) ||
        client.streamSocket.writableLength < SHALLOW_SOCKET_WRITE_GATE_BYTES) &&
      (batch.queuedCharsBySession.get(sessionId) ?? 0) <=
        (options.flushMaxChars ?? Number.POSITIVE_INFINITY)
    ) {
      this.flush(clientId, sessionId)
      return
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  /** Preserve control events at their position in the session stream. */
  enqueueControlEvent(clientId: string, sessionId: string, control: DaemonEvent): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }
    const batch = this.getOrCreateBatch(clientId)
    batch.queue.push(accountDaemonStreamEntry(batch, { sessionId, data: '', control }))
    this.updateBackpressure(clientId, batch)
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  refreshSessionDroppability(sessionId: string): void {
    const droppable = this.isSessionDroppable(sessionId)
    refreshDroppableSessionMembership(this.pendingByClient.values(), sessionId, droppable)
    this.backpressure?.refresh()
  }

  private getOrCreateBatch(clientId: string): PendingStreamDataBatch {
    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = {
        timer: null,
        queue: [],
        queuedChars: 0,
        queuedCharsBySession: new Map(),
        queuedMetadataBytesBySession: new Map(),
        droppableQueuedSessionIds: new Set()
      }
      this.pendingByClient.set(clientId, batch)
    }
    return batch
  }

  queuedCharsForClient(clientId: string): number {
    return this.pendingByClient.get(clientId)?.queuedChars ?? 0
  }

  flush(clientId: string, onlySession?: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    if (batch.timer && onlySession === undefined) {
      clearTimeout(batch.timer)
      batch.timer = null
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      // Reconnection restores from the daemon model, so the disconnected stream copy can be discarded.
      this.clear(clientId)
      return
    }

    flushDaemonStreamBatch(
      clientId,
      batch,
      client.streamSocket,
      client.streamFraming,
      this.maxLineBytes,
      this.heldRefill,
      (id, sessionId, socket, line, done) => this.write(id, sessionId, socket, line, done),
      () => this.updateBackpressure(clientId, batch),
      () => this.pendingByClient.delete(clientId),
      onlySession
    )
  }

  private write(
    clientId: string,
    sessionId: string,
    socket: Socket,
    line: string | Buffer,
    onComplete?: () => void
  ): void {
    if (this.backpressure) {
      this.backpressure.write(clientId, sessionId, socket, line, onComplete)
    } else {
      socket.write(line, onComplete)
    }
  }

  private updateBackpressure(clientId: string, batch: PendingStreamDataBatch): void {
    this.backpressure?.setQueued(
      clientId,
      batch.queuedCharsBySession,
      batch.queuedMetadataBytesBySession
    )
  }

  /** Reset socket-generation state without discarding queued payloads for a replacement stream. */
  replaceStream(clientId: string): void {
    this.removeSnapshot(this.pendingByClient.get(clientId), undefined, undefined, true)
    const batch = this.pendingByClient.get(clientId)
    if (batch?.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    this.heldRefill.clear(clientId)
    this.backpressure?.clear(clientId)
  }

  clear(clientId?: string): void {
    const batches =
      clientId === undefined
        ? Array.from(this.pendingByClient.entries())
        : [[clientId, this.pendingByClient.get(clientId)] as const]

    for (const [id, batch] of batches) {
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
    }
    this.heldRefill.clear(clientId)
    this.backpressure?.clear(clientId)
  }
}
