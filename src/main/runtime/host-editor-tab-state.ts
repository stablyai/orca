import type { ExecutionHostId } from '../../shared/execution-host'
import type { EditorAuthorityHost } from './editor-authority'

/** A diff tab a host opened with no window. Diffs are never persisted, so these are live-only. */
export type HostDiffTabRecord = {
  tabId: string
  fileId: string
  worktreeId: string
  filePath: string
  relativePath: string
  diffSource: 'staged' | 'unstaged'
  language: string
  executionHostId: ExecutionHostId
  groupId: string | null
  /** What the snapshot showed when the host last focused this diff; closing it returns there. */
  returnFocusTabId: string | null
}

/** Per-runtime, process-local editor bookkeeping; nothing here is persisted. */
export class HostEditorTabState {
  private readonly diffsByWorktree = new Map<string, HostDiffTabRecord[]>()
  private readonly saveLanes = new Map<string, Promise<void>>()

  listDiffs(worktreeId: string): readonly HostDiffTabRecord[] {
    return this.diffsByWorktree.get(worktreeId) ?? []
  }

  listDiffWorktreeIds(): string[] {
    return [...this.diffsByWorktree.keys()]
  }

  hasDiffs(): boolean {
    return this.diffsByWorktree.size > 0
  }

  /** Returns the existing tab for the same diff instead of adding a second one. */
  addDiff(record: HostDiffTabRecord): HostDiffTabRecord {
    const diffs = this.diffsByWorktree.get(record.worktreeId) ?? []
    const existing = diffs.find(
      (candidate) =>
        candidate.fileId === record.fileId && candidate.executionHostId === record.executionHostId
    )
    if (existing) {
      return existing
    }
    this.diffsByWorktree.set(record.worktreeId, [...diffs, record])
    return record
  }

  removeDiff(worktreeId: string, tabId: string): boolean {
    const diffs = this.diffsByWorktree.get(worktreeId)
    if (!diffs?.some((diff) => diff.tabId === tabId)) {
      return false
    }
    const remaining = diffs.filter((diff) => diff.tabId !== tabId)
    if (remaining.length === 0) {
      this.diffsByWorktree.delete(worktreeId)
    } else {
      this.diffsByWorktree.set(worktreeId, remaining)
    }
    return true
  }

  focusDiff(
    worktreeId: string,
    tabId: string,
    previousActiveTabId: string | null
  ): HostDiffTabRecord {
    const diffs = this.diffsByWorktree.get(worktreeId) ?? []
    const diff = diffs.find((candidate) => candidate.tabId === tabId)
    if (!diff) {
      throw new Error('tab_not_found')
    }
    if (!previousActiveTabId || previousActiveTabId === tabId) {
      return diff
    }
    const focused = { ...diff, returnFocusTabId: previousActiveTabId }
    this.diffsByWorktree.set(
      worktreeId,
      diffs.map((candidate) => (candidate === diff ? focused : candidate))
    )
    return focused
  }

  setDiffGroups(worktreeId: string, groupIdByTabId: ReadonlyMap<string, string>): void {
    const diffs = this.diffsByWorktree.get(worktreeId)
    if (!diffs) {
      return
    }
    this.diffsByWorktree.set(
      worktreeId,
      diffs.map((diff) => {
        const groupId = groupIdByTabId.get(diff.tabId)
        return groupId && groupId !== diff.groupId ? { ...diff, groupId } : diff
      })
    )
  }

  clearWorktree(worktreeId: string): boolean {
    return this.diffsByWorktree.delete(worktreeId)
  }

  /** A window that takes editor authority owns every worktree's tabs; host diffs die. */
  clearAllDiffs(): string[] {
    const worktreeIds = [...this.diffsByWorktree.keys()]
    this.diffsByWorktree.clear()
    return worktreeIds
  }

  /** Serializes saves of one file on one execution host; the lane is released even on failure. */
  async runInSaveLane<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.saveLanes.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    this.saveLanes.set(key, queued)
    await previous
    try {
      return await run()
    } finally {
      release()
      if (this.saveLanes.get(key) === queued) {
        this.saveLanes.delete(key)
      }
    }
  }
}

/** The runtime that owns host editor bookkeeping (any editor-authority host). */
export type HostEditorTabStateOwner = Pick<EditorAuthorityHost, 'hasLiveWindowDocument'>

const statesByRuntime = new WeakMap<HostEditorTabStateOwner, HostEditorTabState>()

export function getHostEditorTabState(runtime: HostEditorTabStateOwner): HostEditorTabState {
  let state = statesByRuntime.get(runtime)
  if (!state) {
    state = new HostEditorTabState()
    statesByRuntime.set(runtime, state)
  }
  return state
}
