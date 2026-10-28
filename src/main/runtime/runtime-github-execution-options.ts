import type { Repo } from '../../shared/repo-types'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'
import {
  getLocalProjectGhExecOptions,
  type LocalProjectGhExecOptions
} from '../project-runtime-git-options'
import type { HostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'
import type { GitHubParticipantRegistry } from './github-participant-registry'
import { createGitHubExecutionAccountResolver } from './github-participant-execution'

export function getRuntimeGitHubExecutionOptionArgs(
  store: ProjectRuntimeResolutionStore,
  registry: GitHubParticipantRegistry | undefined,
  repo: Repo
): [] | [LocalProjectGhExecOptions] {
  const resolve = createGitHubExecutionAccountResolver(registry, repo.id, repo.ghAccount)
  const options = {
    ...getLocalProjectGhExecOptions(store, { ...repo, ghAccount: resolve() }),
    ...(registry
      ? {
          canStart: () => {
            resolve()
            return true
          }
        }
      : {})
  }
  return Object.keys(options).length > 0 ? [options] : []
}

export function getRuntimeHostedReviewExecutionOptions(
  store: ProjectRuntimeResolutionStore,
  registry: GitHubParticipantRegistry | undefined,
  repo: Repo,
  admissionTier?: GitAdmissionTier
): { localGitExecOptions: HostedReviewLocalGitOptions } | undefined {
  const localGitExecOptions = {
    ...getLocalProjectGhExecOptions(store, repo),
    ...(registry
      ? {
          resolveGitHubAccount: createGitHubExecutionAccountResolver(
            registry,
            repo.id,
            repo.ghAccount
          )
        }
      : {}),
    ...(admissionTier ? { admissionTier } : {})
  }
  return Object.keys(localGitExecOptions).length > 0 ? { localGitExecOptions } : undefined
}
