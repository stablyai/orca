import { OrcaRuntimeWithStopExactTerminalsForWorktree } from './worktree-terminal-stop-targets'
import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'

const PROJECT_INVENTORY_REFRESH_BUDGET_MS = 3_000

/** The value, or null once the deadline passes first. */
async function raceDeadline<T>(value: Promise<T>, deadline: number | undefined): Promise<T | null> {
  if (deadline === undefined) {
    return await value
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      value,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Distinct worktree ids of a project that still hold a pane or PTY on this host. */
export function listProjectTerminalWorktreeIds(
  repoId: string,
  leaves: ReadonlyMap<string, { worktreeId: string; ptyId: string | null }>,
  ptys: ReadonlyMap<string, { worktreeId: string }>
): string[] {
  const worktreeIds = new Set<string>()
  for (const leaf of leaves.values()) {
    if (leaf.ptyId && getRepoIdFromWorktreeId(leaf.worktreeId) === repoId) {
      worktreeIds.add(leaf.worktreeId)
    }
  }
  for (const pty of ptys.values()) {
    if (getRepoIdFromWorktreeId(pty.worktreeId) === repoId) {
      worktreeIds.add(pty.worktreeId)
    }
  }
  return [...worktreeIds]
}

export abstract class OrcaRuntimeWithStopTerminalsForProject extends OrcaRuntimeWithStopExactTerminalsForWorktree {
  /** Projects this host removed; ids are UUIDs, so a remaining row means a same-id sibling. */
  private readonly removedProjectIds = new Set<string>()

  override async acquireWorktreeTerminalSpawn(
    worktreeId?: string,
    opts: { refuseSleptWorktree?: boolean } = {}
  ): Promise<() => void> {
    const release = await super.acquireWorktreeTerminalSpawn(worktreeId, opts)
    const repoId = worktreeId ? getRepoIdFromWorktreeId(worktreeId) : null
    // Why under the lease: a spawn that resolved its workspace before removal queues behind the sweep.
    if (repoId && this.removedProjectIds.has(repoId) && !this.store?.getRepo?.(repoId)) {
      release()
      throw new Error('repo_not_found')
    }
    return release
  }

  /**
   * Stops every terminal this host runs for a project, found through its own PTY table rather
   * than a client's workspace list, which can be unhydrated or hide workspaces.
   */
  async stopTerminalsForProject(
    repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    options: { deadline?: number } = {}
  ): Promise<{ stopped: number }> {
    // Why: after a restart, surviving daemon sessions are in the provider inventory before ptysById.
    // Bounded so a slow worktree scan cannot spend the budget the known PTYs' stops need.
    const refreshDeadline = Math.min(
      options.deadline ?? Infinity,
      Date.now() + PROJECT_INVENTORY_REFRESH_BUDGET_MS
    )
    const projectWorktreeIds = new Set<string>()
    const refresh = (async () => {
      const resolvedWorktrees = [...(await this.getResolvedWorktreeMap()).values()]
      for (const worktree of resolvedWorktrees) {
        if (worktree.repoId === repo.id) {
          projectWorktreeIds.add(worktree.id)
        }
      }
      await this.refreshPtyWorktreeRecordsFromController(resolvedWorktrees, null, refreshDeadline)
    })().catch((error: unknown) => {
      console.warn('[runtime] project terminal inventory refresh failed', error)
    })
    await raceDeadline(refresh, refreshDeadline)
    // Why not the row's stamp: a `runtime:` stamp is how paired clients address a project that runs
    // here, natively or over its nested SSH connection.
    const fence = { resolvedConnectionId: getRepoSshConnectionId(repo) }
    this.removedProjectIds.add(repo.id)
    // Why: a same-id sibling row with the same fence owns PTYs this table cannot tell apart.
    const siblingSharesFence = (this.store?.getRepos?.() ?? []).some(
      (row) =>
        row.id === repo.id &&
        getRepoExecutionHostId(row) !== getRepoExecutionHostId(repo) &&
        getRepoSshConnectionId(row) === fence.resolvedConnectionId
    )
    if (siblingSharesFence) {
      return { stopped: 0 }
    }
    let stopped = 0
    for (const id of listProjectTerminalWorktreeIds(repo.id, this.leaves, this.ptysById)) {
      projectWorktreeIds.add(id)
    }
    for (const id of projectWorktreeIds) {
      const opts = { resolvedWorktreeId: id, ...fence, ...options }
      // Why exclusive: it waits out a spawn that holds the shared lease, so its PTY is registered
      // and stopped. Bounded by the deadline so repo.rm still answers; past it the stop is skipped.
      // A timed-out waiter is dequeued by the lock, so it cannot hold later spawns back.
      const release = await this.acquireWorktreeTerminalMutation(
        id,
        'exclusive',
        options.deadline
      ).catch(() => null)
      try {
        // Why raced: a provider's own exit wait can outlast the budget that keeps repo.rm answering.
        const result = await raceDeadline(
          this.stopTerminalsForWorktree(`id:${id}`, opts),
          options.deadline
        )
        stopped += result?.stopped ?? 0
      } finally {
        release?.()
      }
    }
    return { stopped }
  }
}
