// Every chat record's workspace on the host, kept from the record store's own commits, so a bot's chats
// are found by its home without scanning every record. The one seam between bots and the record store's
// commit hooks (onRecordsChanged, conversationCount, recordStamp, lineageRevision): a store rewrite
// re-wires this file only.
import type { AgentSessionRecordReader } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

/** A committed record and the workspace it was in and is in now (undefined: not there). */
export type RecordWorkspaceChange = {
  sessionId: string
  before: string | undefined
  after: string | undefined
}

type Followed = {
  reader: AgentSessionRecordReader
  /** The store's own listener registration, the same function for as long as that store is open. */
  identity: unknown
  stop: () => void
  lineage: object | undefined
}

export class BotHomeRecords {
  private readonly workspaceOf = new Map<string, string>()
  private readonly idsByWorkspace = new Map<string, Set<string>>()
  private followed: Followed | null = null

  constructor(
    private readonly onChanged: (
      changes: readonly RecordWorkspaceChange[],
      tabsChanged: boolean
    ) => void
  ) {}

  /** Follows the reader's store: `same` when already followed, `seeded` when read whole now (the first
   *  store, or one opened again), `unfollowable` when the reader can't say its commits. */
  follow(reader: AgentSessionRecordReader | null): 'same' | 'seeded' | 'unfollowable' {
    const identity = reader?.onRecordsChanged
    if (!reader || !identity) {
      this.stop()
      return 'unfollowable'
    }
    if (this.followed?.identity === identity) {
      this.followed.reader = reader
      return 'same'
    }
    this.seed(reader)
    return 'seeded'
  }

  get following(): boolean {
    return this.followed !== null
  }

  /** Reads the store whole again, as on a store opened anew. */
  seed(reader: AgentSessionRecordReader): void {
    this.stop()
    this.workspaceOf.clear()
    this.idsByWorkspace.clear()
    for (const record of reader.listRecords()) {
      this.track(record.sessionId, record.location.workspaceId)
    }
    const stop = reader.onRecordsChanged!((ids, tabsChanged) =>
      this.recordsChanged(ids, tabsChanged)
    )
    this.followed = {
      reader,
      identity: reader.onRecordsChanged,
      stop,
      lineage: reader.lineageRevision?.()
    }
  }

  stop(): void {
    this.followed?.stop()
    this.followed = null
  }

  /** The record's row identity as stored now; a commit that writes it changes it. Undefined from a
   *  reader that can't say it, which the stamp check then never flags. */
  stampOf(reader: AgentSessionRecordReader, sessionId: string): object | undefined {
    return reader.recordStamp?.(sessionId)
  }

  /** Whether the reader can say row identities at all. */
  stamps(reader: AgentSessionRecordReader): boolean {
    return reader.recordStamp !== undefined
  }

  idsIn(workspaceId: string): ReadonlySet<string> {
    return this.idsByWorkspace.get(workspaceId) ?? new Set()
  }

  workspaceOfSession(sessionId: string): string | undefined {
    return this.workspaceOf.get(sessionId)
  }

  /** O(1): what the store says that a commit went unheard, if anything (its record count, its lineage). */
  missed(reader: AgentSessionRecordReader): string | null {
    if (!this.followed) {
      return null
    }
    const count = reader.conversationCount?.()
    if (count !== undefined && count !== this.workspaceOf.size) {
      return 'record count'
    }
    if (reader.lineageRevision && reader.lineageRevision() !== this.followed.lineage) {
      return 'lineage'
    }
    return null
  }

  private track(sessionId: string, workspaceId: string | undefined): void {
    const before = this.workspaceOf.get(sessionId)
    if (before === workspaceId) {
      return
    }
    if (before !== undefined) {
      this.idsByWorkspace.get(before)?.delete(sessionId)
      this.workspaceOf.delete(sessionId)
    }
    if (workspaceId !== undefined) {
      this.workspaceOf.set(sessionId, workspaceId)
      let ids = this.idsByWorkspace.get(workspaceId)
      if (!ids) {
        ids = new Set()
        this.idsByWorkspace.set(workspaceId, ids)
      }
      ids.add(sessionId)
    }
  }

  private recordsChanged(ids: readonly string[], tabsChanged: boolean): void {
    const followed = this.followed
    if (!followed) {
      return
    }
    followed.lineage = followed.reader.lineageRevision?.()
    const changes = ids.map((sessionId): RecordWorkspaceChange => {
      const before = this.workspaceOf.get(sessionId)
      const after = followed.reader.getRecord(sessionId)?.location.workspaceId
      this.track(sessionId, after)
      return { sessionId, before, after }
    })
    this.onChanged(changes, tabsChanged)
  }
}
