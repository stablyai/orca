import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../shared/external-worktree-visibility'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY } from '../../../shared/worktree-runtime-capabilities'
import type { Repo } from '../../../shared/repo-types'
import { readProjectedLocalIssueRepositorySync } from '../../github/sdlc-issue-repository'
import type { RpcContext } from './core'

type RepoProjectionContext = Pick<RpcContext, 'clientCapabilities' | 'runtime'>

function withProjectedIssueRepository(repo: Repo): Repo {
  if (repo.issueRepository !== undefined || getRepoExecutionHostId(repo) !== 'local') {
    return repo
  }
  const projected = readProjectedLocalIssueRepositorySync(repo.path)
  return projected ? { ...repo, issueRepository: projected } : repo
}

export function projectRepoVisibilityForClient(repo: Repo, context: RepoProjectionContext): Repo {
  const projectedRepo = withProjectedIssueRepository(repo)
  if (
    context.clientCapabilities?.includes(WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY) ||
    projectedRepo.kind === 'folder' ||
    projectedRepo.externalWorktreeVisibility !== undefined
  ) {
    return projectedRepo
  }
  const settings = context.runtime.requireStore?.().getSettings()
  return {
    ...projectedRepo,
    externalWorktreeVisibility: effectiveExternalWorktreeVisibility(
      projectedRepo,
      isLegacyRepoForExternalWorktreeVisibility(projectedRepo),
      settings ? (settings.worktreeVisibilityDefaults ?? { external: 'hide' }) : undefined
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
