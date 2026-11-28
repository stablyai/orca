import type { Socket } from 'node:net'
import { STREAM_ENTRY_OVERHEAD_BYTES } from './daemon-stream-entry-accounting'
import { PausedSessionDeliveries } from './daemon-stream-paused-deliveries'
import type { DaemonStreamDataBatcherOptions } from './daemon-stream-data-batcher-options'
import { LongPauseLogLimiter } from '../../../../shared/terminal/pty/flow-control/long-pause-log-limiter'

// Each session pauses on its own backlog so a flooding sibling cannot queue ahead of an interactive one.
// Worst case held per session is SESSION_HIGH_WATER_BYTES plus one PTY read.
const SESSION_HIGH_WATER_BYTES = 256 * 1024
const SESSION_LOW_WATER_BYTES = 128 * 1024
// Last resort when many sessions flood at once: tighter per-session watermarks until the total drains.
const HIGH_WATER_BYTES = 4 * 1024 * 1024
const LOW_WATER_BYTES = 1024 * 1024
const PRESSURED_SESSION_HIGH_WATER_BYTES = 64 * 1024
const PRESSURED_SESSION_LOW_WATER_BYTES = 32 * 1024

type StallReason = 'input' | 'timeout' | 'released' | 'terminating' | 'exited'

type ClientBacklog = {
  queuedChars: Map<string, number>
  queuedMetadataBytes: Map<string, number>
  pendingWriteBytes: Map<string, number>
}

type DaemonStreamBackpressureOptions = Pick<
  DaemonStreamDataBatcherOptions,
  'isSessionAttachedToClient' | 'onLongProducerPause' | 'incarnationOf'
>

/** Counts held strings and socket writes together, including small writes that bypass the hold. */
export class DaemonStreamBackpressure {
  private readonly clients = new Map<string, ClientBacklog>()
  private readonly pausedAtBySession = new Map<string, number>()
  private lastBytesBySession: ReadonlyMap<string, number> = new Map()
  private lastTotalBytes = 0
  // Keep-tail dropping bounds stalled consumers; pausing again would freeze the shell behind them.
  private readonly stallReleasedSessions = new Set<string>()
  private pressured = false
  // Cleared on resume, so a delivery credit never outlives its pause.
  private readonly deliveries = new PausedSessionDeliveries()
  // Terminating, exited or viewerless producers: skipped until 'released' or their output drains.
  private readonly unpausableSessions = new Set<string>()
  // The producer incarnation each pause or exited record belongs to; a respawn under the same id starts clean.
  private readonly recordIncarnation = new Map<string, string | undefined>()
  private readonly longPauseLog = new LongPauseLogLimiter()

  constructor(
    private readonly setPaused: (
      sessionId: string,
      paused: boolean,
      onStallTimeout?: (reason: StallReason) => void
    ) => boolean | 'terminating' | 'exited' | 'detached' | void,
    private readonly isDroppable: (sessionId: string) => boolean,
    // Stall release must reconcile cached droppability for already-queued data.
    private readonly onDroppabilityChanged: (sessionId: string) => void = () => {},
    options: DaemonStreamBackpressureOptions = {}
  ) {
    this.ownsSession = options.isSessionAttachedToClient ?? (() => true)
    this.reportLongPause = options.onLongProducerPause ?? (() => {})
    this.incarnationOf = options.incarnationOf ?? (() => undefined)
  }

  private readonly ownsSession: (clientId: string, sessionId: string) => boolean
  private readonly reportLongPause: (details: Record<string, unknown>) => void
  private readonly incarnationOf: (sessionId: string) => string | undefined

  setQueued(
    clientId: string,
    queuedChars: ReadonlyMap<string, number>,
    queuedMetadataBytes: ReadonlyMap<string, number> = new Map()
  ): void {
    const client = this.getOrCreateClient(clientId)
    client.queuedChars = new Map(queuedChars)
    client.queuedMetadataBytes = new Map(queuedMetadataBytes)
    this.pruneClient(clientId, client)
    this.refresh()
  }

  write(
    clientId: string,
    sessionId: string,
    socket: Pick<Socket, 'write'>,
    line: string | Buffer,
    onComplete?: () => void,
    // A no-op refill frame moves none of this session's output, so it is not its delivery.
    carriesSessionOutput = true
  ): void {
    const client = this.getOrCreateClient(clientId)
    const bytes =
      (typeof line === 'string' ? Buffer.byteLength(line) : line.length) +
      STREAM_ENTRY_OVERHEAD_BYTES
    client.pendingWriteBytes.set(sessionId, (client.pendingWriteBytes.get(sessionId) ?? 0) + bytes)
    this.refresh()
    socket.write(line, (error?: Error | null) => {
      // A disconnected client's callbacks must not debit a replacement connection's writes.
      if (this.clients.get(clientId) === client) {
        if (
          !error &&
          carriesSessionOutput &&
          this.pausedAtBySession.has(sessionId) &&
          this.ownsSession(clientId, sessionId)
        ) {
          this.deliveries.credit(sessionId, clientId)
        }
        const remaining = (client.pendingWriteBytes.get(sessionId) ?? 0) - bytes
        if (remaining > 0) {
          client.pendingWriteBytes.set(sessionId, remaining)
        } else {
          client.pendingWriteBytes.delete(sessionId)
        }
        this.pruneClient(clientId, client)
        this.refresh()
      }
      onComplete?.()
    })
  }

  refresh(): void {
    const bytesBySession = new Map<string, number>()
    // Sessions big enough to pause at either watermark; the decision pass visits only these and the paused ones.
    const pauseCandidates: string[] = []
    const addSessionBytes = (sessionId: string, bytes: number): void => {
      const before = bytesBySession.get(sessionId) ?? 0
      bytesBySession.set(sessionId, before + bytes)
      if (
        before < PRESSURED_SESSION_HIGH_WATER_BYTES &&
        before + bytes >= PRESSURED_SESSION_HIGH_WATER_BYTES
      ) {
        pauseCandidates.push(sessionId)
      }
    }
    // Include droppable data: stall release ends only when all queued and in-flight bytes leave.
    const accountedSessions = new Set<string>()
    let total = 0
    for (const [clientId, client] of this.clients) {
      for (const [sessionId, chars] of client.queuedChars) {
        accountedSessions.add(sessionId)
        // Background data has its own keep-tail budget; only its undroppable frames need pausing.
        if (this.isDroppable(sessionId)) {
          continue
        }
        const bytes = 2 * chars
        total += bytes
        if (this.ownsSession(clientId, sessionId)) {
          addSessionBytes(sessionId, bytes)
        }
      }
      for (const counts of [client.queuedMetadataBytes, client.pendingWriteBytes]) {
        for (const [sessionId, bytes] of counts) {
          accountedSessions.add(sessionId)
          total += bytes
          if (this.ownsSession(clientId, sessionId)) {
            addSessionBytes(sessionId, bytes)
          }
        }
      }
    }
    if (total >= HIGH_WATER_BYTES) {
      this.pressured = true
    } else if (total <= LOW_WATER_BYTES) {
      this.pressured = false
    }

    this.lastBytesBySession = bytesBySession
    this.lastTotalBytes = total
    const pauseAt = this.pressured ? PRESSURED_SESSION_HIGH_WATER_BYTES : SESSION_HIGH_WATER_BYTES
    const resumeAt = this.pressured ? PRESSURED_SESSION_LOW_WATER_BYTES : SESSION_LOW_WATER_BYTES
    for (const sessionId of this.pausedAtBySession.keys()) {
      if ((bytesBySession.get(sessionId) ?? 0) <= resumeAt) {
        this.resume(sessionId, 'drained')
      }
    }
    for (const sessionId of pauseCandidates) {
      if (
        this.pausedAtBySession.has(sessionId) ||
        this.unpausableSessions.has(sessionId) ||
        (bytesBySession.get(sessionId) ?? 0) < pauseAt ||
        this.stallReleasedSessions.has(sessionId) ||
        // Background output has its own keep-tail budget; pause it only as the last resort.
        (!this.pressured && this.isDroppable(sessionId))
      ) {
        continue
      }
      // Sent once per record; 'released' (detach, attach, failed termination) drops pause and unpausable so the next refresh asks again.
      let incarnation: string | undefined
      const paused = this.setPaused(sessionId, true, (reason) =>
        this.onStall(sessionId, reason, incarnation)
      )
      if (paused === false) {
        continue
      }
      // Looked up once per record, never per refresh.
      incarnation = this.incarnationOf(sessionId)
      this.recordIncarnation.set(sessionId, incarnation)
      if (paused === 'exited' || paused === 'terminating' || paused === 'detached') {
        this.markUnpausable(sessionId)
      } else {
        this.pausedAtBySession.set(sessionId, Date.now())
      }
    }
    // Resume ordinary pausing only after the session has no remaining backlog.
    for (const sessions of [this.stallReleasedSessions, this.unpausableSessions]) {
      for (const sessionId of sessions) {
        if (!accountedSessions.has(sessionId)) {
          sessions.delete(sessionId)
          this.dropRecordIfUnused(sessionId)
        }
      }
    }
  }

  /** Called before a session's PTY output is queued: only a live producer enqueues, so this is when a respawn shows. */
  noteSessionOutput(sessionId: string): void {
    const live = this.recordIncarnation.has(sessionId) ? this.incarnationOf(sessionId) : undefined
    // A late tail queued after the session left the host has no incarnation; only a new producer resets.
    if (live === undefined || this.recordIncarnation.get(sessionId) === live) {
      return
    }
    // Every record belonged to an earlier incarnation: pause, unpausable, keep-tail and credit all go.
    const wasKeepTail = this.stallReleasedSessions.delete(sessionId)
    this.unpausableSessions.delete(sessionId)
    this.forgetPause(sessionId)
    // Only keep-tail changes droppability; anything else would rescan every backlog.
    if (wasKeepTail) {
      this.onDroppabilityChanged(sessionId)
    }
  }

  /** A terminating, exited or viewerless producer is never asked to pause; it is skipped until 'released' or its output drains. */
  private markUnpausable(sessionId: string): void {
    this.unpausableSessions.add(sessionId)
    this.forgetPause(sessionId)
  }

  private forgetPause(sessionId: string): void {
    this.pausedAtBySession.delete(sessionId)
    this.deliveries.forget(sessionId)
    this.dropRecordIfUnused(sessionId)
  }

  private dropRecordIfUnused(sessionId: string): void {
    const records = [this.pausedAtBySession, this.unpausableSessions, this.stallReleasedSessions]
    if (!records.some((record) => record.has(sessionId))) {
      this.recordIncarnation.delete(sessionId)
    }
  }

  private onStall(sessionId: string, reason: StallReason, incarnation: string | undefined): void {
    // A handler from an earlier incarnation speaks for a producer that no longer holds this id.
    if (
      !this.recordIncarnation.has(sessionId) ||
      this.recordIncarnation.get(sessionId) !== incarnation
    ) {
      return
    }
    if (reason === 'exited' || reason === 'terminating') {
      this.markUnpausable(sessionId)
      return
    }
    if (reason === 'released') {
      // Keep-tail stays: the stalled consumer may still be there, and only a drain proves it isn't.
      this.unpausableSessions.delete(sessionId)
      this.forgetPause(sessionId)
      return
    }
    if (this.deliveries.progressed(sessionId)) {
      // A draining consumer resumes losslessly so the program can read input; the next refresh re-pauses.
      if (this.pausedAtBySession.has(sessionId)) {
        this.resume(
          sessionId,
          reason === 'input' ? 'typed input' : 'timeout watchdog, still draining'
        )
      }
      return
    }
    // Typed input never sheds; a stalled consumer waits for the unchanged 60 s deadline.
    if (reason === 'timeout') {
      this.releaseStalledSession(sessionId)
    }
  }

  /** Release a stalled producer into keep-tail dropping; lost contact does not prove child exit. */
  private releaseStalledSession(sessionId: string): void {
    this.stallReleasedSessions.add(sessionId)
    this.onDroppabilityChanged(sessionId)
    if (this.pausedAtBySession.has(sessionId)) {
      this.resume(sessionId, 'timeout watchdog, consumer stalled')
    }
    this.refresh()
  }

  isStallReleased(sessionId: string): boolean {
    return this.stallReleasedSessions.has(sessionId)
  }

  clear(clientId?: string): void {
    if (clientId === undefined) {
      // The refresh below drops keep-tail and unpausable records along with their incarnation.
      this.clients.clear()
      this.deliveries.clear()
    } else {
      this.clients.delete(clientId)
      this.deliveries.forgetClient(clientId)
    }
    this.refresh()
  }

  private resume(sessionId: string, reason: string): void {
    const pausedAt = this.pausedAtBySession.get(sessionId)
    this.forgetPause(sessionId)
    this.setPaused(sessionId, false)
    const pausedMs = pausedAt === undefined ? 0 : Date.now() - pausedAt
    const suppressed = this.longPauseLog.admit(pausedMs, reason.startsWith('timeout'))
    if (suppressed === null) {
      return
    }
    this.reportLongPause({
      sessionId,
      pausedMs,
      reason,
      sessionBacklogBytes: this.lastBytesBySession.get(sessionId) ?? 0,
      totalBacklogBytes: this.lastTotalBytes,
      suppressedSinceLast: suppressed
    })
  }

  private getOrCreateClient(clientId: string): ClientBacklog {
    let client = this.clients.get(clientId)
    if (!client) {
      client = {
        queuedChars: new Map(),
        queuedMetadataBytes: new Map(),
        pendingWriteBytes: new Map()
      }
      this.clients.set(clientId, client)
    }
    return client
  }

  private pruneClient(clientId: string, client: ClientBacklog): void {
    if (
      client.queuedChars.size === 0 &&
      client.queuedMetadataBytes.size === 0 &&
      client.pendingWriteBytes.size === 0
    ) {
      this.clients.delete(clientId)
    }
  }
}
