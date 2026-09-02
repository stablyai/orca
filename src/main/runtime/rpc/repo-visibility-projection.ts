import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../shared/external-worktree-visibility'
import { WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { Repo } from '../../../shared/repo-types'
import type { RpcContext } from './core'

type RepoProjectionContext = Pick<RpcContext, 'clientCapabilities' | 'runtime'>

export function projectRepoVisibilityForClient(repo: Repo, context: RepoProjectionContext): Repo {
  if (
    context.clientCapabilities?.includes(WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY) ||
    repo.kind === 'folder' ||
    repo.externalWorktreeVisibility !== undefined
  ) {
    return repo
  }
  return {
    ...repo,
    externalWorktreeVisibility: effectiveExternalWorktreeVisibility(
      repo,
      isLegacyRepoForExternalWorktreeVisibility(repo),
      context.runtime.getClientSettings?.().worktreeVisibilityDefaults
    )
  }
}

export function projectRepoResultVisibilityForClient<T extends object>(
  result: T,
  context: RepoProjectionContext
): T {
  const repo = (result as { repo?: Repo }).repo
  return repo ? { ...result, repo: projectRepoVisibilityForClient(repo, context) } : result
}
