import {
  flushDaemonStreamBatch,
  SHALLOW_SOCKET_WRITE_GATE_BYTES
} from './daemon-stream-batch-flush'
import { removeQueuedObservations } from './daemon-stream-observation-removal'
import type { Socket } from 'node:net'
import { NDJSON_MAX_LINE_BYTES } from './ndjson'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import { accountDaemonStreamEntry } from './daemon-stream-entry-accounting'
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
import { DaemonTransientAdmission } from './daemon-transient-admission'
import type { TerminalTransientSink } from '../../shared/terminal-transient-observation'

// Why framing rides the client: frames are encoded at flush time, so a replacement stream gets its own.
type StreamDataClient = Pick<ConnectedDaemonClient, 'streamSocket' | 'streamFraming'>

// 2ms: each chunk waits a half-window here AND again in main's PTY batch; a smaller interval still coalesces bursts while cutting the fixed latency tax (~8ms of the measured ~19ms DSR-under-load latency).
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
  private readonly transientAdmissions = new Map<string, DaemonTransientAdmission>()

  prepareTransients(
    clientId: string,
    sessionId: string,
    subscriptionId: string,
    streamId: string
  ): (() => TerminalTransientSink | undefined) | null {
    const client = this.getClient(clientId)
    const socket = client?.streamSocket
    const admission = this.transientAdmissions.get(clientId)
    if (!socket || socket.destroyed || (admission && !admission.canBind(sessionId, socket))) {
      return null
    }
    return () => {
      if (
        this.getClient(clientId)?.streamSocket !== socket ||
        this.transientAdmissions.get(clientId) !== admission ||
        socket.destroyed ||
        (admission && !admission.canBind(sessionId, socket))
      ) {
        return undefined
      }
      return this.bindTransients(clientId, sessionId, subscriptionId, streamId)
    }
  }

  bindTransients(
    clientId: string,
    sessionId: string,
    subscriptionId: string,
    streamId: string
  ): TerminalTransientSink | undefined {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return undefined
    }
    let admission = this.transientAdmissions.get(clientId)
    if (!admission) {
      const owner = new DaemonTransientAdmission(
        client.streamSocket,
        client.streamFraming ?? 'ndjson',
        (id, observation) => {
          if (!owner.ownsSocket(this.getClient(clientId)?.streamSocket)) {
            observation.release()
            return
          }
          const batch = this.getOrCreateBatch(clientId)
          batch.queue.push(
            accountDaemonStreamEntry(batch, { sessionId: id, data: '', observation })
          )
          this.updateBackpressure(clientId, batch)
          if (!batch.timer) {
            batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
          }
        },
        (id) => removeQueuedObservations(this.pendingByClient.get(clientId), id),
        () => {
          if (owner.idle && this.transientAdmissions.get(clientId) === owner) {
            this.transientAdmissions.delete(clientId)
          }
        },
        () => this.flush(clientId)
      )
      admission = owner
      this.transientAdmissions.set(clientId, owner)
    } else {
      admission.replaceSocket(client.streamSocket, client.streamFraming ?? 'ndjson')
    }
    return admission.bind(sessionId, subscriptionId, streamId)
  }

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    const isBackgroundDroppable = options.isSessionDroppable ?? (() => false)
    // A stall-released session is droppable for as long as its backlog survives, whether or not main
    // has backgrounded it: keep-tail thinning is what lets its producer run past an unreachable client.
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

  /** Append a pre-shaped stream event at the current position in the session's byte order (scan handoff markers, gaps, transient facts). */
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
        admission: this.transientAdmissions.get(clientId),
        queuedChars: 0,
        queuedCharsBySession: new Map(),
        queuedMetadataBytesBySession: new Map(),
        droppableQueuedSessionIds: new Set()
      }
      this.pendingByClient.set(clientId, batch)
    }
    batch.admission = this.transientAdmissions.get(clientId)
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
      // A vanished stream socket drops the batch — the model owns the bytes and reconnect restores from a snapshot.
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
    const client = this.getClient(clientId)
    const admission = this.transientAdmissions.get(clientId)
    if (client?.streamSocket) {
      admission?.replaceSocket(client.streamSocket, client.streamFraming ?? 'ndjson')
    } else {
      admission?.invalidateBindings()
    }
    removeQueuedObservations(this.pendingByClient.get(clientId))
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
      removeQueuedObservations(this.pendingByClient.get(id))
      for (const entry of batch?.queue ?? []) {
        entry.lease?.release()
      }
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
    }
    this.heldRefill.clear(clientId)
    this.backpressure?.clear(clientId)
  }
}
