import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import {
  getLocalProjectWorktreeGitOptions,
  type LocalProjectWorktreeGitOptions
} from '../../project-runtime-git-options'
import type { CommitMessageAgentRuntimeTarget } from '../../text-generation/commit-message-agent-environment'
import type { CommitMessageGenerationTarget } from '../../text-generation/commit-message-text-generation'
import { resolve } from 'node:path'
import { listRepoWorktreeGraph } from '../../repo-worktrees'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { splitWorktreeId } from '../../../shared/worktree/id'

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function getCandidateLocalWorktreePaths(
  worktreePath: string,
  resolvedWorktreePath: string
): Set<string> {
  return new Set([worktreePath, resolvedWorktreePath].map(comparableLocalPath))
}

function hasRegisteredWorktreeMetaForRepo(
  store: Store,
  repoId: string,
  candidatePaths: Set<string>
): boolean {
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed?.repoId === repoId && candidatePaths.has(comparableLocalPath(parsed.worktreePath))) {
      return true
    }
  }
  return false
}

function comparableRemotePath(value: string): string {
  return value.replace(/[/\\]+$/g, '')
}

function hasRegisteredRemoteWorktreeMetaForRepo(
  store: Store,
  repoId: string,
  worktreePath: string
): boolean {
  const comparableWorktreePath = comparableRemotePath(worktreePath)
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (
      parsed?.repoId === repoId &&
      comparableRemotePath(parsed.worktreePath) === comparableWorktreePath
    ) {
      return true
    }
  }
  return false
}

async function localRepoOwnsWorktree(
  store: Store,
  repo: Repo,
  worktreePath: string
): Promise<boolean> {
  let resolvedWorktreePath: string
  try {
    resolvedWorktreePath = await resolveRegisteredWorktreePath(worktreePath, store)
  } catch {
    return false
  }
  const candidatePaths = getCandidateLocalWorktreePaths(worktreePath, resolvedWorktreePath)
  if (candidatePaths.has(comparableLocalPath(repo.path))) {
    return true
  }
  if (hasRegisteredWorktreeMetaForRepo(store, repo.id, candidatePaths)) {
    return true
  }
  try {
    // WSL Git names drive-backed worktrees differently from host Git.
    const worktrees = await listRepoWorktreeGraph(
      repo,
      getLocalProjectWorktreeGitOptions(store, repo)
    )
    return worktrees.some((worktree) => candidatePaths.has(comparableLocalPath(worktree.path)))
  } catch {
    return false
  }
}

function remoteRepoOwnsWorktree(store: Store, repo: Repo, worktreePath: string): boolean {
  return (
    comparableRemotePath(repo.path) === comparableRemotePath(worktreePath) ||
    hasRegisteredRemoteWorktreeMetaForRepo(store, repo.id, worktreePath)
  )
}

export async function getRepoForSourceControlAi(
  store: Store,
  args: { repoId?: string; worktreePath: string; connectionId?: string }
): Promise<Repo | null> {
  if (!args.repoId) {
    return null
  }
  const repo = store.getRepo(args.repoId)
  if (!repo) {
    return null
  }
  if (args.connectionId) {
    if (repo.connectionId !== args.connectionId) {
      return null
    }
    // Shared SSH connections can host several repos; apply overrides only to the verified owner.
    return remoteRepoOwnsWorktree(store, repo, args.worktreePath) ? repo : null
  }
  if (repo.connectionId) {
    return null
  }
  // Renderer repoId is advisory until local worktree ownership is verified.
  return (await localRepoOwnsWorktree(store, repo, args.worktreePath)) ? repo : null
}

export function getLocalAgentRuntimeTarget(
  gitOptions: LocalProjectWorktreeGitOptions
): CommitMessageAgentRuntimeTarget {
  return gitOptions.wslDistro
    ? { runtime: 'wsl', wslDistro: gitOptions.wslDistro }
    : { runtime: 'host' }
}

export async function resolveModelDiscoveryLocalPath(
  store: Store,
  requestedPath: string
): Promise<string> {
  try {
    return await resolveRegisteredWorktreePath(requestedPath, store)
  } catch (error) {
    const folderWorkspaces =
      typeof store.getFolderWorkspaces === 'function' ? store.getFolderWorkspaces() : []
    const isFolderWorkspaceRoot = folderWorkspaces.some(
      (workspace) =>
        comparableLocalPath(workspace.folderPath) === comparableLocalPath(requestedPath)
    )
    if (!isFolderWorkspaceRoot) {
      throw error
    }
    return resolveAuthorizedPath(requestedPath, store)
  }
}

export function getLocalTextGenerationTarget(
  worktreePath: string,
  gitOptions: LocalProjectWorktreeGitOptions,
  env?: NodeJS.ProcessEnv
): Extract<CommitMessageGenerationTarget, { kind: 'local' }> {
  return {
    kind: 'local',
    cwd: worktreePath,
    ...(gitOptions.wslDistro ? { wslDistro: gitOptions.wslDistro } : {}),
    ...(env ? { env } : {})
  }
}
