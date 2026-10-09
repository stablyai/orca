import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { formatRepoRelinkError, type RepoPathStatusEntry } from '../../shared/repo-path-status'
import type { Repo } from '../../shared/repo-types'
import { getRepoMainWorktreeId, splitWorktreeId } from '../../shared/worktree/id'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { resolveRepoHostFilesystem } from '../repo-relink/repo-host-filesystem'
import { RepoPathStatusCollector } from '../repo-relink/repo-path-status'
import { createRepoRelinkHostGit } from '../repo-relink/repo-relink-host-git'
import {
  validateRepoRelinkTarget,
  type RepoRelinkEvidence
} from '../repo-relink/repo-relink-validation'
import {
  planRepoRelinkWorktreeMoves,
  type WorktreeIdMove
} from '../repo-relink/repo-relink-worktree-moves'
import { copyShellHistoryForRenamedWorktree } from '../repo-relink/shell-history-relink'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeRepositoryRelinkDependencies = {
  getStore: () => RuntimeStore | null
  resolveRepo: (selector: string) => Promise<Repo>
  invalidateResolvedWorktrees: () => void
  invalidateWorktreeScan: (repoId: string) => void
  notifyWorktreeFolderRenamed: (
    repoId: string,
    oldWorktreeId: string,
    newWorktreeId: string
  ) => void
  notifyReposChanged: () => void
  resolveFilesystem?: typeof resolveRepoHostFilesystem
  createHostGit?: typeof createRepoRelinkHostGit
  copyShellHistory?: typeof copyShellHistoryForRenamedWorktree
}

export type RepoRelinkOptions = { force?: boolean; hostId?: ExecutionHostId }

export type RepoRelinkResult = {
  repo: Repo
  evidence: RepoRelinkEvidence
  movedWorktrees: WorktreeIdMove[]
  staleLinkedWorktreeCount: number
}

/** Every worktree id this profile holds state for under one repo on one host. */
function collectKnownWorktreeIds(
  store: RuntimeStore,
  repo: Repo,
  hostId: ExecutionHostId
): string[] {
  const ids = new Set<string>(
    Object.keys(store.getAllWorktreeMetaForHost?.(hostId) ?? store.getAllWorktreeMeta())
  )
  const session = store.getWorkspaceSession?.(hostId)
  for (const worktreeId of Object.keys(session?.tabsByWorktree ?? {})) {
    ids.add(worktreeId)
  }
  for (const worktreeId of Object.keys(session?.unifiedTabs ?? {})) {
    ids.add(worktreeId)
  }
  for (const worktreeId of Object.keys(store.getAllWorktreeLineage?.() ?? {})) {
    ids.add(worktreeId)
  }
  return [...ids].filter((worktreeId) => splitWorktreeId(worktreeId)?.repoId === repo.id)
}

export class RuntimeRepositoryRelinkController {
  private readonly pathStatuses: RepoPathStatusCollector
  private readonly relinksInFlight = new Map<string, Promise<RepoRelinkResult>>()

  constructor(private readonly deps: RuntimeRepositoryRelinkDependencies) {
    this.pathStatuses = new RepoPathStatusCollector(
      deps.resolveFilesystem ?? resolveRepoHostFilesystem
    )
  }

  async listPathStatuses(options: { force?: boolean } = {}): Promise<RepoPathStatusEntry[]> {
    return this.pathStatuses.collect(this.deps.getStore()?.getRepos() ?? [], options)
  }

  async relink(
    selector: string,
    path: string,
    options: RepoRelinkOptions = {}
  ): Promise<RepoRelinkResult> {
    const repo = await this.resolveTargetRepo(selector, options.hostId)
    const key = `${getRepoExecutionHostId(repo)}\0${repo.id}`
    // Why serialize: two relinks of one repo would each migrate from the same old ids.
    const previous = this.relinksInFlight.get(key) ?? Promise.resolve(null)
    const next = previous
      .catch(() => null)
      .then(() => this.relinkResolved(repo.id, getRepoExecutionHostId(repo), path, options))
    this.relinksInFlight.set(key, next)
    try {
      return await next
    } finally {
      if (this.relinksInFlight.get(key) === next) {
        this.relinksInFlight.delete(key)
      }
    }
  }

  private async resolveTargetRepo(selector: string, hostId?: ExecutionHostId): Promise<Repo> {
    if (!hostId) {
      return this.deps.resolveRepo(selector)
    }
    const repo = this.deps
      .getStore()
      ?.getRepos()
      .find(
        (candidate) => candidate.id === selector && getRepoExecutionHostId(candidate) === hostId
      )
    if (!repo) {
      throw new Error('repo_not_found')
    }
    return repo
  }

  private async relinkResolved(
    repoId: string,
    hostId: ExecutionHostId,
    path: string,
    options: RepoRelinkOptions
  ): Promise<RepoRelinkResult> {
    const store = this.deps.getStore()
    if (!store?.setRepoPathForHost || !store.migrateWorktreeIdentity) {
      throw new Error('runtime_unavailable')
    }
    // Re-read after waiting: an earlier relink may have moved this repo.
    const repo = store
      .getRepos()
      .find((candidate) => candidate.id === repoId && getRepoExecutionHostId(candidate) === hostId)
    if (!repo) {
      throw new Error('repo_not_found')
    }
    if (parseExecutionHostId(hostId)?.kind === 'runtime') {
      throw new Error(
        formatRepoRelinkError(
          'repo_relink_host_unverifiable',
          'This repository belongs to another Orca server. Relink it from that server.'
        )
      )
    }
    const knownWorktreeIds = collectKnownWorktreeIds(store, repo, hostId)
    const mainWorktreeId = getRepoMainWorktreeId(repo)
    const plan = await validateRepoRelinkTarget({
      repo,
      requestedPath: path.trim(),
      registeredRepos: store.getRepos(),
      knownLinkedWorktreePaths: knownWorktreeIds
        .filter((worktreeId) => worktreeId !== mainWorktreeId)
        .flatMap((worktreeId) => splitWorktreeId(worktreeId)?.worktreePath ?? []),
      force: options.force === true,
      fs: (this.deps.resolveFilesystem ?? resolveRepoHostFilesystem)(hostId),
      git: (this.deps.createHostGit ?? createRepoRelinkHostGit)(repo, hostId)
    })
    const { moves, staleLinkedWorktreeIds } = planRepoRelinkWorktreeMoves({
      repoId: repo.id,
      oldPath: plan.oldPath,
      newPath: plan.newPath,
      knownWorktreeIds,
      gitWorktrees: plan.gitWorktrees
    })
    const updated = store.setRepoPathForHost(repo.id, hostId, plan.newPath)
    if (!updated) {
      throw new Error('repo_not_found')
    }
    for (const move of moves) {
      store.migrateWorktreeIdentity(move.oldWorktreeId, move.newWorktreeId, hostId)
    }
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      const copyShellHistory = this.deps.copyShellHistory ?? copyShellHistoryForRenamedWorktree
      await Promise.all(
        moves.map((move) => copyShellHistory(move.oldWorktreeId, move.newWorktreeId))
      )
    }
    invalidateAuthorizedRootsCache()
    this.pathStatuses.invalidate(repo.id)
    this.deps.invalidateResolvedWorktrees()
    this.deps.invalidateWorktreeScan(repo.id)
    for (const move of moves) {
      this.deps.notifyWorktreeFolderRenamed(repo.id, move.oldWorktreeId, move.newWorktreeId)
    }
    this.deps.notifyReposChanged()
    return {
      repo: updated,
      evidence: plan.evidence,
      movedWorktrees: moves,
      staleLinkedWorktreeCount: staleLinkedWorktreeIds.length
    }
  }
}
