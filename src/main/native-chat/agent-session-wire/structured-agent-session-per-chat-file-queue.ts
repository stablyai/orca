// The chats the background copy of old per-chat files owes a look, in order: a chat the disk guard
// turned back, then listed chats in tab order, then each file the walk of the old-file root finds
// that a record names, then chats a transient failure put back. Derived from the records and the
// files on disk, never stored, and each chat comes up once a launch but for those two.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { PerChatFileCopyDeps } from './structured-agent-session-per-chat-file-copy'
import { walkPerChatFiles } from './structured-agent-session-per-chat-file-walk'

const MAX_TRANSIENT_TRIES = 3

export class StructuredAgentSessionPerChatFileQueue {
  private readonly listed: string[]
  private readonly walk: AsyncGenerator<string>
  private recordsByDirectory: Map<string, AgentSessionRecord> | null = null
  private readonly visited = new Set<string>()
  private readonly retries: AgentSessionRecord[] = []
  private readonly tries = new Map<string, number>()
  private deferred: AgentSessionRecord | null = null

  constructor(
    private readonly deps: Pick<PerChatFileCopyDeps, 'database' | 'store' | 'listedIds'> & {
      /** A directory with no `journal.db`: a pre-SQLite transcript, or an older build's. */
      onLeftover: () => void
      /** A file no record names: a deleted chat, or an older build's recovery copy. */
      onOrphan: () => void
    }
  ) {
    this.listed = [...deps.listedIds]
    this.walk = walkPerChatFiles(deps.database.stateDirectory, deps.onLeftover)
  }

  async next(): Promise<AgentSessionRecord | null> {
    const deferred = this.deferred
    if (deferred) {
      this.deferred = null
      return deferred
    }
    for (let id = this.listed.shift(); id !== undefined; id = this.listed.shift()) {
      const record = this.deps.store.getRecord(id)
      if (record && this.firstVisit(record)) {
        return record
      }
    }
    for (let next = await this.walk.next(); !next.done; next = await this.walk.next()) {
      const record = this.recordForDirectory(next.value)
      if (!record) {
        // Never opened or deleted.
        this.deps.onOrphan()
      } else if (this.firstVisit(record)) {
        return record
      }
    }
    return this.retries.shift() ?? null
  }

  /** Turned back by the disk guard: first in line for the next run. */
  defer(record: AgentSessionRecord): void {
    this.deferred = record
  }

  /** A transient failure: tried again after the walk, at most three tries a launch. */
  retry(record: AgentSessionRecord): void {
    const tries = (this.tries.get(record.sessionId) ?? 0) + 1
    this.tries.set(record.sessionId, tries)
    if (tries < MAX_TRANSIENT_TRIES) {
      this.retries.push(record)
    }
  }

  private firstVisit(record: AgentSessionRecord): boolean {
    if (this.visited.has(record.sessionId)) {
      return false
    }
    this.visited.add(record.sessionId)
    return true
  }

  private recordForDirectory(directory: string): AgentSessionRecord | null {
    // Built on the first file found, so a walk that finds none never hashes a record.
    this.recordsByDirectory ??= new Map(
      this.deps.store.listRecords().map((record) => [
        this.deps.database.legacyDirectoryFor({
          workspaceId: record.location.workspaceId,
          sessionId: record.sessionId
        }),
        record
      ])
    )
    return this.recordsByDirectory.get(directory) ?? null
  }
}
