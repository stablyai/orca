import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isWslUncPath } from '../../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { RuntimeGitTarget } from '../../../runtime/integrations/git/runtime-git-command-target'
import {
  runtimeRepoSelectorHostId,
  runtimeRepoSelectorText,
  type RuntimeRepoSelector
} from '../../../runtime/workspaces/catalog/runtime-repo-selector'
import { runtimePathsEqual } from '../../../runtime/workspaces/catalog/runtime-worktree-path-identity'

export type LocalSourceControlWorktree = Worktree & { git?: GitWorktreeInfo }

async function requireLocalCheckout(checkoutPath: string): Promise<void> {
  if (!isAbsolute(checkoutPath) || isWslUncPath(checkoutPath)) {
    throw new Error('Local Git execution requires an absolute native checkout path.')
  }
  try {
    const [directory, dotGit] = await Promise.all([
      stat(checkoutPath),
      stat(join(checkoutPath, '.git'))
    ])
    if (directory.isDirectory() && (dotGit.isDirectory() || dotGit.isFile())) {
      return
    }
  } catch {
    // Report the selected execution policy instead of an opaque filesystem error.
  }
  throw new Error(`The shared checkout is not available on this computer: ${checkoutPath}`)
}

function localRepo(repo: Repo): Repo {
  const { ghAccount: _remoteAccount, ...metadata } = repo
  return { ...metadata, connectionId: null, executionHostId: 'local' }
}

export function createLocalSourceControlTargets(
  repos: Repo[],
  worktrees: LocalSourceControlWorktree[],
  getSignal?: () => AbortSignal | undefined
) {
  const resolveRepo = async (selector: RuntimeRepoSelector): Promise<Repo> => {
    const text = runtimeRepoSelectorText(selector)
    const hostId = runtimeRepoSelectorHostId(selector)
    const candidates = repos.filter((repo) => {
      if (hostId && getRepoExecutionHostId(repo) !== hostId) {
        return false
      }
      if (text.startsWith('id:')) {
        return repo.id === text.slice(3)
      }
      if (text.startsWith('path:')) {
        return runtimePathsEqual(repo.path, text.slice(5))
      }
      if (text.startsWith('name:')) {
        return repo.displayName === text.slice(5)
      }
      return repo.id === text || runtimePathsEqual(repo.path, text) || repo.displayName === text
    })
    if (candidates.length !== 1) {
      throw new Error(candidates.length > 1 ? 'selector_ambiguous' : 'repo_not_found')
    }
    const repo = candidates[0]
    await requireLocalCheckout(repo.path)
    return localRepo(repo)
  }

  const resolveWorktree = async (selector: string): Promise<LocalSourceControlWorktree> => {
    const candidates = worktrees.filter((worktree) => {
      if (selector.startsWith('id:')) {
        return worktreeIdsEqual(worktree.id, selector.slice(3))
      }
      if (selector.startsWith('path:')) {
        return runtimePathsEqual(worktree.path, selector.slice(5))
      }
      return worktreeIdsEqual(worktree.id, selector) || runtimePathsEqual(worktree.path, selector)
    })
    if (candidates.length !== 1) {
      throw new Error(candidates.length > 1 ? 'selector_ambiguous' : 'worktree_not_found')
    }
    await requireLocalCheckout(candidates[0].path)
    return candidates[0]
  }

  const resolveRuntimeGitTarget = async (selector: string): Promise<RuntimeGitTarget> => {
    const worktree = await resolveWorktree(selector)
    const owners = repos.filter((repo) => repo.id === worktree.repoId)
    if (owners.length !== 1) {
      throw new Error('worktree_execution_host_unresolved')
    }
    const repo = localRepo(owners[0])
    const { runtimeOwnerEnvironmentId: _owner, ...metadata } = worktree
    const localWorktree = {
      ...metadata,
      hostId: 'local' as const,
      git: worktree.git ?? worktree
    }
    const localGitOptions = { hostGit: true as const, signal: getSignal?.() }
    return { worktree: localWorktree, repo, executionHostId: 'local', localGitOptions }
  }

  const resolveTarget = async (args: { repoSelector: string; worktreeSelector?: string }) => {
    const repo = await resolveRepo(args.repoSelector)
    if (!args.worktreeSelector) {
      return { repo, repoPath: repo.path }
    }
    const worktree = await resolveWorktree(args.worktreeSelector)
    if (worktree.repoId !== repo.id) {
      throw new Error('Access denied: worktree does not belong to repository')
    }
    return { repo, repoPath: worktree.path }
  }

  return { resolveRepo, resolveTarget, resolveRuntimeGitTarget, resolveWorktree }
}
