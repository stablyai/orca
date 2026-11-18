import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

/** Everything a projected git-worktree row is computed from. Metadata objects are replaced on
 *  write; the only in-place edits (read-time identity migration, SSH target reassignment, rename
 *  history) set `instanceId`, `hostId` or `priorWorktreeIds`, so those are compared too. */
export type WorktreeRowProjectionInput = {
  repoId: string
  repoDisplayName: string | undefined
  expectedHostId: string
  git: GitWorktreeInfo
  meta: WorktreeMeta | undefined
}

type Entry<Row> = {
  input: WorktreeRowProjectionInput
  instanceId: string | undefined
  hostId: string | undefined
  priorWorktreeIds: readonly string[] | undefined
  row: Row
}

function sameGit(a: GitWorktreeInfo, b: GitWorktreeInfo): boolean {
  return (
    a.path === b.path &&
    a.head === b.head &&
    a.branch === b.branch &&
    a.isBare === b.isBare &&
    a.isSparse === b.isSparse &&
    a.isMainWorktree === b.isMainWorktree &&
    a.removalError === b.removalError &&
    a.removing === b.removing &&
    a.removalRecorded === b.removalRecorded
  )
}

function sameInput<Row>(entry: Entry<Row>, input: WorktreeRowProjectionInput): boolean {
  const known = entry.input
  return (
    known.meta === input.meta &&
    entry.instanceId === input.meta?.instanceId &&
    entry.hostId === input.meta?.hostId &&
    entry.priorWorktreeIds === input.meta?.priorWorktreeIds &&
    known.repoId === input.repoId &&
    known.repoDisplayName === input.repoDisplayName &&
    known.expectedHostId === input.expectedHostId &&
    // Scans rebuild their entries and stored-row fallbacks build new ones, so git is compared by value.
    sameGit(known.git, input.git)
  )
}

/** Reuses a projected row while its inputs are unchanged, so a metadata write re-merges only the
 *  rows it touched instead of every row in the fleet. Rows are shared: consumers must copy, never edit. */
export class WorktreeRowProjectionMemo<Row> {
  private readonly byRepo = new Map<string, Map<string, Entry<Row>>>()

  rowFor(
    repoKey: string,
    worktreeId: string,
    input: WorktreeRowProjectionInput,
    build: () => Row
  ): Row {
    let rows = this.byRepo.get(repoKey)
    const known = rows?.get(worktreeId)
    if (known && sameInput(known, input)) {
      return known.row
    }
    const row = build()
    if (!rows) {
      rows = new Map()
      this.byRepo.set(repoKey, rows)
    }
    rows.set(worktreeId, {
      input: { ...input, git: { ...input.git } },
      instanceId: input.meta?.instanceId,
      hostId: input.meta?.hostId,
      priorWorktreeIds: input.meta?.priorWorktreeIds,
      row
    })
    return row
  }

  /** After a whole-repo projection: drop rows its scan no longer lists. */
  keepOnly(repoKey: string, worktreeIds: ReadonlySet<string>): void {
    const rows = this.byRepo.get(repoKey)
    for (const id of rows?.keys() ?? []) {
      if (!worktreeIds.has(id)) {
        rows!.delete(id)
      }
    }
  }

  /** After a fleet projection: drop repos that are no longer registered. */
  retainRepos(repoKeys: ReadonlySet<string>): void {
    for (const key of this.byRepo.keys()) {
      if (!repoKeys.has(key)) {
        this.byRepo.delete(key)
      }
    }
  }
}
