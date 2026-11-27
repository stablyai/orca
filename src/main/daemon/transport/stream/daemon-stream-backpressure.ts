import type { Socket } from 'node:net'
import { STREAM_ENTRY_OVERHEAD_BYTES } from './daemon-stream-entry-accounting'

// Each session pauses on its own backlog so a flooding sibling cannot queue ahead of an interactive one.
// Worst case held per session is SESSION_HIGH_WATER_BYTES plus one PTY read.
const SESSION_HIGH_WATER_BYTES = 256 * 1024
const SESSION_LOW_WATER_BYTES = 128 * 1024
// Last resort when many sessions flood at once: halve every session's watermarks until the total drains.
const HIGH_WATER_BYTES = 4 * 1024 * 1024
const LOW_WATER_BYTES = 1024 * 1024
const LONG_PAUSE_LOG_MS = 2_000

type ClientBacklog = {
  queuedChars: Map<string, number>
  queuedMetadataBytes: Map<string, number>
  pendingWriteBytes: Map<string, number>
}

/** Counts held strings and socket writes together, including small writes that bypass the hold. */
export class DaemonStreamBackpressure {
  private readonly clients = new Map<string, ClientBacklog>()
  private readonly pausedAtBySession = new Map<string, number>()
  private lastBytesBySession: ReadonlyMap<string, number> = new Map()
  private lastTotalBytes = 0
  // Keep-tail dropping bounds stalled consumers; pausing again would freeze the shell behind them.
  private readonly stallReleasedSessions = new Set<string>()
  private pressured = false

  constructor(
    private readonly setPaused: (
      sessionId: string,
      paused: boolean,
      onStallTimeout?: () => void
    ) => void,
    private readonly isDroppable: (sessionId: string) => boolean,
    private readonly ownsSession: (clientId: string, sessionId: string) => boolean = () => true,
    // Stall release must reconcile cached droppability for already-queued data.
    private readonly onDroppabilityChanged: (sessionId: string) => void = () => {}
  ) {}

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
    onComplete?: () => void
  ): void {
    const client = this.getOrCreateClient(clientId)
    const bytes =
      (typeof line === 'string' ? Buffer.byteLength(line) : line.length) +
      STREAM_ENTRY_OVERHEAD_BYTES
    client.pendingWriteBytes.set(sessionId, (client.pendingWriteBytes.get(sessionId) ?? 0) + bytes)
    this.refresh()
    socket.write(line, () => {
      // A disconnected client's callbacks must not debit a replacement connection's writes.
      if (this.clients.get(clientId) === client) {
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
          bytesBySession.set(sessionId, (bytesBySession.get(sessionId) ?? 0) + bytes)
        }
      }
      for (const counts of [client.queuedMetadataBytes, client.pendingWriteBytes]) {
        for (const [sessionId, bytes] of counts) {
          accountedSessions.add(sessionId)
          total += bytes
          if (this.ownsSession(clientId, sessionId)) {
            bytesBySession.set(sessionId, (bytesBySession.get(sessionId) ?? 0) + bytes)
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
    const pauseAt = this.pressured ? SESSION_LOW_WATER_BYTES : SESSION_HIGH_WATER_BYTES
    const resumeAt = this.pressured ? SESSION_LOW_WATER_BYTES / 2 : SESSION_LOW_WATER_BYTES
    for (const sessionId of this.pausedAtBySession.keys()) {
      if ((bytesBySession.get(sessionId) ?? 0) <= resumeAt) {
        this.resume(sessionId, 'drained')
      }
    }
    for (const [sessionId, bytes] of bytesBySession) {
      if (bytes >= pauseAt && !this.stallReleasedSessions.has(sessionId)) {
        if (!this.pausedAtBySession.has(sessionId)) {
          this.pausedAtBySession.set(sessionId, Date.now())
        }
        // Detach/termination may have released the session's pause since the last update.
        this.setPaused(sessionId, true, () => this.releaseStalledSession(sessionId))
      }
    }
    for (const sessionId of this.stallReleasedSessions) {
      // Resume ordinary pausing only after this session has no remaining backlog.
      if (!accountedSessions.has(sessionId)) {
        this.stallReleasedSessions.delete(sessionId)
      }
    }
  }

  /** Release a stalled producer into keep-tail dropping; lost contact does not prove child exit. */
  releaseStalledSession(sessionId: string): void {
    this.stallReleasedSessions.add(sessionId)
    this.onDroppabilityChanged(sessionId)
    if (this.pausedAtBySession.has(sessionId)) {
      this.resume(sessionId, 'stall watchdog')
    }
    this.refresh()
  }

  isStallReleased(sessionId: string): boolean {
    return this.stallReleasedSessions.has(sessionId)
  }

  clear(clientId?: string): void {
    if (clientId === undefined) {
      this.clients.clear()
      this.stallReleasedSessions.clear()
    } else {
      this.clients.delete(clientId)
    }
    this.refresh()
  }

  private resume(sessionId: string, reason: 'drained' | 'stall watchdog'): void {
    const pausedAt = this.pausedAtBySession.get(sessionId)
    this.pausedAtBySession.delete(sessionId)
    this.setPaused(sessionId, false)
    const pausedMs = pausedAt === undefined ? 0 : Date.now() - pausedAt
    if (reason !== 'drained' || pausedMs >= LONG_PAUSE_LOG_MS) {
      console.warn(
        `[daemon] terminal output paused ${pausedMs}ms, resumed by ${reason}: session=${sessionId} sessionBacklogBytes=${this.lastBytesBySession.get(sessionId) ?? 0} totalBacklogBytes=${this.lastTotalBytes}`
      )
    }
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
