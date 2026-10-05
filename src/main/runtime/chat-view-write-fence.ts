import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

export type ChatViewWriteAdmission = 'apply' | 'duplicate' | 'superseded'

/** `confirmed` once the write landed; until then a same-seq resend applies again (absolute, idempotent). */
type LastSeqByWriter = Map<string, { seq: number; confirmed: boolean }>

/**
 * Orders each client process's chat-pair writes per parent tab at the host's mutation point.
 *
 * Why no eviction: a frame from an older transport can reach the host after a newer request from
 * the same writer, so a forgotten mark would admit it as fresh. Marks live as long as the parent
 * tab and die with it, with its worktree, or with the host process.
 */
export class ChatViewWriteFence {
  private readonly byWorktree = new Map<string, Map<string, LastSeqByWriter>>()

  /** Synchronous so no other request can interleave between the decision and the write. */
  admit(
    worktreeId: string,
    parentTabId: string,
    writerId: string,
    seq: number
  ): ChatViewWriteAdmission {
    let parents = this.byWorktree.get(worktreeId)
    const last = parents?.get(parentTabId)?.get(writerId)
    if (last && seq < last.seq) {
      return 'superseded'
    }
    if (last?.seq === seq && last.confirmed) {
      return 'duplicate'
    }
    if (!parents) {
      parents = new Map()
      this.byWorktree.set(worktreeId, parents)
    }
    let lastSeqByWriter = parents.get(parentTabId)
    if (!lastSeqByWriter) {
      lastSeqByWriter = new Map()
      parents.set(parentTabId, lastSeqByWriter)
    }
    lastSeqByWriter.set(writerId, { seq, confirmed: false })
    return 'apply'
  }

  /** The write admitted at `seq` landed; a later resend of it is a duplicate. */
  confirm(worktreeId: string, parentTabId: string, writerId: string, seq: number): void {
    const last = this.byWorktree.get(worktreeId)?.get(parentTabId)?.get(writerId)
    if (last?.seq === seq) {
      last.confirmed = true
    }
  }

  /** Drops the marks of every parent tab the worktree's current snapshot no longer holds. */
  retainParents(worktreeId: string, liveParentTabIds: ReadonlySet<string>): void {
    const parents = this.byWorktree.get(worktreeId)
    if (!parents) {
      return
    }
    for (const parentTabId of parents.keys()) {
      if (!liveParentTabIds.has(parentTabId)) {
        parents.delete(parentTabId)
      }
    }
    if (parents.size === 0) {
      this.byWorktree.delete(worktreeId)
    }
  }

  /** Each close (host, renderer, retirement) stores a snapshot without the tab, so prune there. */
  retainSnapshotParents(worktreeId: string, snapshot: RuntimeMobileSessionTabsSnapshot): void {
    this.retainParents(
      worktreeId,
      new Set(snapshot.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id)))
    )
  }

  forgetWorktree(worktreeId: string): void {
    this.byWorktree.delete(worktreeId)
  }
}
