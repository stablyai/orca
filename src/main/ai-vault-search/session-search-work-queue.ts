import { SessionInputFrontier } from '../ai-vault/session-input-frontier'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { fileIdentity } from './session-search-file-cursor'
import { sessionSearchReadDecision } from './session-search-read-decision'
import type { SessionSearchFileRow, SessionSearchIndexStore } from './session-search-store'

export type SessionSearchWork = {
  candidate: SessionFileCandidate
  force: boolean
  version: number
  metadata: boolean
}

/** A unique path owns its debt even when it leaves the next recent list. */
export class SessionSearchWorkQueue {
  private readonly backlog = new SessionInputFrontier<SessionSearchWork>()
  private readonly changed = new SessionInputFrontier<SessionSearchWork>()
  private version = 0
  private chooseChanged = true
  private due = new Set<string>()

  get size(): number {
    return this.backlog.size + this.changed.size
  }
  get left(): number {
    return this.size - this.due.size
  }

  enqueue(
    candidate: SessionFileCandidate,
    store: SessionSearchIndexStore,
    force = false,
    recent = true,
    metadata = false
  ): void {
    const path = candidate.file.path
    const row = store.fileRow(path)
    const decision = sessionSearchReadDecision({
      candidate,
      row,
      cursor: row ? store.indexedFile(path, fileIdentity(candidate.file)) : null,
      cutoffMs: store.retentionCutoff
    })
    if (!force && decision === 'skip') {
      return
    }
    const existing = this.changed.get(path) ?? this.backlog.get(path)
    const entry = {
      candidate,
      force: force || (existing?.force ?? false),
      version: ++this.version,
      metadata: metadata || (existing?.metadata ?? false)
    }
    const queue = this.changed.has(path)
      ? this.changed
      : this.backlog.has(path)
        ? this.backlog
        : recent
          ? this.changed
          : this.backlog
    queue.set(path, entry)
    this.rowChanged(path, row)
  }

  hasPublicationDebt(path: string): boolean {
    const work = this.changed.get(path) ?? this.backlog.get(path)
    return !!work && (work.force || work.metadata)
  }

  next(): SessionSearchWork | undefined {
    const preferred = this.chooseChanged ? this.changed : this.backlog
    this.chooseChanged = !this.chooseChanged
    return preferred.first ?? (preferred === this.changed ? this.backlog : this.changed).first
  }

  get(path: string): SessionSearchWork | undefined {
    return this.changed.get(path) ?? this.backlog.get(path)
  }

  acknowledge(work: SessionSearchWork, retry: boolean): void {
    const path = work.candidate.file.path
    const queue = this.changed.has(path) ? this.changed : this.backlog
    if (queue.get(path)?.version !== work.version) {
      return
    }
    queue.delete(path)
    this.due.delete(path)
    if (retry) {
      this.backlog.set(path, work)
    }
  }

  remove(path: string): void {
    this.backlog.delete(path)
    this.changed.delete(path)
    this.due.delete(path)
  }

  rowChanged(path: string, row: SessionSearchFileRow | undefined): void {
    if (row?.state === 'due' && (this.changed.has(path) || this.backlog.has(path))) {
      this.due.add(path)
    } else {
      this.due.delete(path)
    }
  }
}
