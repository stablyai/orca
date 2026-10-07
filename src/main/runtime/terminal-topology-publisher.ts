import { isDeepStrictEqual } from 'node:util'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalTopologySlice } from '../../shared/terminal-topology-slice'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  emptyTerminalTopologySlice,
  projectTerminalTopologySlice,
  type UnsequencedTerminalTopologySlice
} from './terminal-topology-projection'

/** A persisted worktree and the host partition that owns its rows. */
export type WorkspaceSessionOwner = { hostId: ExecutionHostId; session: WorkspaceSessionState }

type PublishedSlice = { publishSeq: number; snapshot: UnsequencedTerminalTopologySlice }

export type TerminalTopologySink = (slice: TerminalTopologySlice) => void

/**
 * Pushes a worktree's topology slice whenever a persisted write changes it by value.
 * Compares by value because some persistence writers edit session objects in place.
 */
export class TerminalTopologyPublisher {
  private readonly published = new Map<string, PublishedSlice>()
  private lastSeq = 0
  private dirty = false
  private failureLogged = false

  constructor(
    private readonly readOwners: () => Map<string, WorkspaceSessionOwner>,
    private readonly sink: TerminalTopologySink
  ) {}

  markDirty(): void {
    if (this.dirty) {
      return
    }
    this.dirty = true
    // Coalesces a burst of writes in one task into one projection.
    queueMicrotask(() => this.flush())
  }

  flush(): void {
    if (!this.dirty) {
      return
    }
    this.dirty = false
    // A failed projection or push is logged once; it never reaches the write that notified it.
    try {
      this.reconcile()
    } catch (error) {
      if (!this.failureLogged) {
        this.failureLogged = true
        console.warn('[terminal-topology] publish failed; persistence is unaffected:', error)
      }
    }
  }

  /** A publishSeq whose push includes every write made before this call. */
  settle(worktreeId?: string): number {
    this.flush()
    return (worktreeId ? this.published.get(worktreeId)?.publishSeq : undefined) ?? this.lastSeq
  }

  private reconcile(): void {
    const owners = this.readOwners()
    const changed: UnsequencedTerminalTopologySlice[] = []
    for (const [worktreeId, owner] of owners) {
      const next = projectTerminalTopologySlice(owner.session, owner.hostId, worktreeId)
      if (!isDeepStrictEqual(this.published.get(worktreeId)?.snapshot, next)) {
        changed.push(structuredClone(next))
      }
    }
    const removed: UnsequencedTerminalTopologySlice[] = []
    for (const [worktreeId, { snapshot }] of this.published) {
      if (!owners.has(worktreeId)) {
        removed.push(emptyTerminalTopologySlice(snapshot.hostId, worktreeId, snapshot.revision))
      }
    }
    for (const snapshot of removed) {
      this.published.delete(snapshot.worktreeId)
      this.send({ publishSeq: ++this.lastSeq, snapshot })
    }
    for (const snapshot of changed) {
      const entry = { publishSeq: ++this.lastSeq, snapshot }
      this.published.set(snapshot.worktreeId, entry)
      this.send(entry)
    }
  }

  private send({ publishSeq, snapshot }: PublishedSlice): void {
    this.sink({ ...snapshot, publishSeq })
  }
}
