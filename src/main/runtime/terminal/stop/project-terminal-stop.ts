import { OrcaRuntimeWithStopExactTerminalsForWorktree } from './worktree-terminal-stop-targets'
import {
  getConnectionExecutionHostId,
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Repo } from '../../../../shared/repo-types'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import { deleteRemovedOwnerBrowserProfile } from '../../browser-host/managed-browser-profile-removal'
import { listFailedAgentLaunchWorktreeIds } from '../../../agent-launch/agent-launch-pane-attachment'
import {
  TerminalUpdateAdmission,
  type WorktreeTerminalSpawnLeaseOptions
} from './terminal-update-admission'
import {
  closeStructuredSessionsForWorktree,
  createStructuredSweepProgress,
  listStructuredSessionsForProject,
  retireStructuredSessionTabsForWorktree,
  unclosedStructuredSessions
} from '../../structured-session-worktree-teardown'

const PROJECT_INVENTORY_REFRESH_BUDGET_MS = 3_000
// Inside repo.rm's 15 s client timeout after the 10 s terminal budget.
const PROJECT_CHAT_CLOSE_FLOOR_MS = 3_000

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
  /** Removed projects' spawn hosts by id; ids are UUIDs, so a remaining row means a same-id sibling. */
  private readonly removedProjectHosts = new Map<string, Set<ExecutionHostId>>()
  /** Closed by an update's last census until the stop; every spawn lease passes it. */
  readonly terminalUpdateAdmission = new TerminalUpdateAdmission()

  /**
   * `target` is the spawn's own workspace copy: the host whose provider runs it. An update's closed
   * admission still lets through an attach to `reattachSessionId`, calling `requireAttachOnly` so
   * the caller spawns attach-only.
   */
  override async acquireWorktreeTerminalSpawn(
    target: HostWorktreeTarget | undefined,
    opts: WorktreeTerminalSpawnLeaseOptions = {}
  ): Promise<() => void> {
    // Admission first: the whole lease, lock wait included, is a spawn an update's census awaits.
    return await this.terminalUpdateAdmission.hold(
      opts.reattachSessionId,
      () => this.acquireProjectTerminalSpawn(target, opts),
      opts.requireAttachOnly
    )
  }

  private async acquireProjectTerminalSpawn(
    target: HostWorktreeTarget | undefined,
    opts: WorktreeTerminalSpawnLeaseOptions
  ): Promise<() => void> {
    const release = await super.acquireWorktreeTerminalSpawn(target, opts)
    const repoId = target ? getRepoIdFromWorktreeId(target.id) : null
    const removedHosts = repoId ? this.removedProjectHosts.get(repoId) : undefined
    // Why under the lease: a spawn that resolved its workspace before removal queues behind the sweep.
    // Why the fence: a surviving same-id row on another host must not admit the removed host's spawn.
    if (
      target &&
      repoId &&
      removedHosts &&
      !this.removedProjectAdmitsSpawn(repoId, removedHosts, target.hostId)
    ) {
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
    options: { deadline?: number; closeStructuredSessions?: boolean } = {}
  ): Promise<{ stopped: number }> {
    const { closeStructuredSessions, ...stopOptions } = options
    // Why alongside, with its own floor: a failed or budget-spent terminal stop must not skip the
    // chat closes, since their tabs are retired either way.
    const chats = closeStructuredSessions
      ? this.closeStructuredSessionsForProject(
          repo,
          options.deadline === undefined
            ? undefined
            : Math.max(options.deadline, Date.now() + PROJECT_CHAT_CLOSE_FLOOR_MS)
        ).catch((error: unknown) => {
          console.warn('[runtime] project agent session close failed', error)
        })
      : null
    let worktreeIds: readonly string[] = []
    try {
      const result = await this.stopProjectPtys(repo, stopOptions)
      worktreeIds = result.worktreeIds
      return { stopped: result.stopped }
    } finally {
      await chats
      if (closeStructuredSessions) {
        this.releaseProjectHostSessions(repo.id, worktreeIds)
      }
    }
  }

  /** Browser pages and failed-launch records of a removed project's workspaces on this host. */
  private releaseProjectHostSessions(repoId: string, knownWorktreeIds: readonly string[]): void {
    // Why: page records carry no host, so a surviving same-id row's pages are indistinguishable.
    if (this.rowsRunHere().some((row) => row.id === repoId)) {
      return
    }
    const pageOwners = [
      ...getRuntimeBrowserPageRegistry(this)
        .listPages()
        .map((page) => page.workspaceId),
      ...listFailedAgentLaunchWorktreeIds(),
      ...(this.agentBrowserBridge?.tabWorktreeIds?.() ?? []).map((id) => id ?? '')
    ]
    const worktreeIds = new Set(
      [...knownWorktreeIds, ...pageOwners].filter((id) => getRepoIdFromWorktreeId(id) === repoId)
    )
    for (const worktreeId of worktreeIds) {
      this.releaseRemovedWorktreeHostSessions(worktreeId, 'project-removal')
    }
    deleteRemovedOwnerBrowserProfile({ kind: 'repo', id: repoId })
  }

  private async stopProjectPtys(
    repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    options: { deadline?: number }
  ): Promise<{ stopped: number; worktreeIds: readonly string[] }> {
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
    const removedHosts = this.removedProjectHosts.get(repo.id) ?? new Set<ExecutionHostId>()
    removedHosts.add(getConnectionExecutionHostId(fence.resolvedConnectionId))
    this.removedProjectHosts.set(repo.id, removedHosts)
    if (this.projectSiblingSharesFence(repo)) {
      return { stopped: 0, worktreeIds: [] }
    }
    for (const id of listProjectTerminalWorktreeIds(repo.id, this.leaves, this.ptysById)) {
      projectWorktreeIds.add(id)
    }
    // Why all at once: one deadline covers the project, so a slow worktree must not spend the
    // budget its siblings' stops need; each still holds only its own worktree's lock.
    const stopWorktree = async (id: string): Promise<number> => {
      const opts = { resolvedWorktreeId: id, ...fence, ...options, requestStopsPastDeadline: true }
      // Why exclusive: it waits out a spawn that holds the shared lease, so its PTY is registered
      // and stopped. Bounded by the deadline so repo.rm still answers; past it PTYs are only asked.
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
        return result?.stopped ?? 0
      } finally {
        release?.()
      }
    }
    // Why rounds: the inventory refresh may still add workspaces after its own budget gave up.
    const started = new Set<string>()
    const stops: PromiseSettledResult<number>[] = []
    for (;;) {
      const added = [...projectWorktreeIds].filter((id) => !started.has(id))
      if (added.length === 0) {
        break
      }
      for (const id of added) {
        started.add(id)
      }
      stops.push(...(await Promise.allSettled(added.map(stopWorktree))))
    }
    const failure = stops.find((stop) => stop.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
    const stopped = stops.reduce(
      (total, stop) => total + (stop.status === 'fulfilled' ? stop.value : 0),
      0
    )
    return { stopped, worktreeIds: [...projectWorktreeIds] }
  }

  /**
   * Closes a removed project's native chats on this host and retires their chat tabs. They have
   * no PTY or pane, so the terminal sweep never reaches them. Best-effort: the project is gone.
   */
  private async closeStructuredSessionsForProject(
    repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    deadline: number | undefined
  ): Promise<void> {
    if (this.projectSiblingSharesFence(repo)) {
      return
    }
    const { members, live } = listStructuredSessionsForProject(repo.id, {
      resolvedConnectionId: getRepoSshConnectionId(repo)
    })
    const progress = createStructuredSweepProgress(live)
    await raceDeadline(
      closeStructuredSessionsForWorktree(progress, deadline ?? Infinity, { runtime: this }),
      deadline
    )
    const liveIds = new Set(live.map((session) => session.sessionId))
    await retireStructuredSessionTabsForWorktree(
      [
        ...members.filter((session) => !liveIds.has(session.sessionId)),
        ...unclosedStructuredSessions(progress)
      ],
      this
    )
  }

  /** Only a surviving row on the spawn's own host, or any row when no removal touched it. */
  private removedProjectAdmitsSpawn(
    repoId: string,
    removedHosts: ReadonlySet<ExecutionHostId>,
    spawnHostId: ExecutionHostId
  ): boolean {
    // Why every row: a `runtime:` stamp can name files registered here (repo-execution-host.ts).
    const survivors = (this.store?.getRepos?.() ?? []).filter((row) => row.id === repoId)
    if (!removedHosts.has(spawnHostId)) {
      return survivors.length > 0
    }
    return survivors.some(
      (row) => getConnectionExecutionHostId(getRepoSshConnectionId(row)) === spawnHostId
    )
  }

  /** A paired server's row is residue here: its sessions run on that server, never in this process. */
  private rowsRunHere(): Repo[] {
    return (this.store?.getRepos?.() ?? []).filter(
      (row) => parseExecutionHostId(getRepoExecutionHostId(row))?.kind !== 'runtime'
    )
  }

  /** A same-id sibling row with the same fence owns sessions this host cannot tell apart. */
  private projectSiblingSharesFence(
    repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
  ): boolean {
    const connectionId = getRepoSshConnectionId(repo)
    return this.rowsRunHere().some(
      (row) =>
        row.id === repo.id &&
        getRepoExecutionHostId(row) !== getRepoExecutionHostId(repo) &&
        getRepoSshConnectionId(row) === connectionId
    )
  }
}
