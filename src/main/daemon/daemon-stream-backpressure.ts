import type { Socket } from 'node:net'
import { STREAM_ENTRY_OVERHEAD_BYTES } from './daemon-stream-entry-accounting'

const HIGH_WATER_BYTES = 4 * 1024 * 1024
const LOW_WATER_BYTES = 1024 * 1024
const SESSION_HIGH_WATER_BYTES = 64 * 1024
const SESSION_LOW_WATER_BYTES = 32 * 1024

type ClientBacklog = {
  queuedChars: Map<string, number>
  queuedMetadataBytes: Map<string, number>
  pendingWriteBytes: Map<string, number>
}

/** Counts held strings and socket writes together, including small writes that bypass the hold. */
export class DaemonStreamBackpressure {
  private readonly clients = new Map<string, ClientBacklog>()
  private readonly pausedSessions = new Set<string>()
  private pressured = false

  constructor(
    private readonly setPaused: (sessionId: string, paused: boolean) => void,
    private readonly isDroppable: (sessionId: string) => boolean,
    private readonly ownsSession: (clientId: string, sessionId: string) => boolean = () => true
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
    line: string,
    onComplete?: () => void
  ): void {
    const client = this.getOrCreateClient(clientId)
    const bytes = Buffer.byteLength(line) + STREAM_ENTRY_OVERHEAD_BYTES
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
    let total = 0
    for (const [clientId, client] of this.clients) {
      for (const [sessionId, chars] of client.queuedChars) {
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

    for (const sessionId of this.pausedSessions) {
      if (!this.pressured || (bytesBySession.get(sessionId) ?? 0) <= SESSION_LOW_WATER_BYTES) {
        this.pausedSessions.delete(sessionId)
        this.setPaused(sessionId, false)
      }
    }
    if (!this.pressured) {
      return
    }
    for (const [sessionId, bytes] of bytesBySession) {
      if (bytes >= SESSION_HIGH_WATER_BYTES) {
        this.pausedSessions.add(sessionId)
        // Detach/termination may have released the session's pause since the last update.
        this.setPaused(sessionId, true)
      }
    }
  }

  clear(clientId?: string): void {
    if (clientId === undefined) {
      this.clients.clear()
    } else {
      this.clients.delete(clientId)
    }
    this.refresh()
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
