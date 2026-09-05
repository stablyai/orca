import type { ExecutionHostId } from '../../shared/execution-host'
import type { HostedReviewProvider } from '../../shared/hosted-review'
import type { HostedReviewCreationProvider } from '../../shared/hosted-review-creation-providers'
import { isAzureDevOpsReviewCreationAuthenticated } from '../azure-devops/pull-request-creation'
import { isBitbucketReviewCreationAuthenticated } from '../bitbucket/pull-request-creation'
import { isGiteaReviewCreationAuthenticated } from '../gitea/pull-request-creation'
import { getEnterpriseGitHubRepoSlug } from '../github/github-enterprise-repository'
import { acquire, ghExecFileAsync, release } from '../github/gh-utils'
import { getProjectSlug } from '../gitlab/client'
import {
  acquire as acquireGlab,
  glabExecFileAsync,
  glabRepoExecOptions,
  release as releaseGlab
} from '../gitlab/gl-utils'
import { hostedReviewSshConnectionId } from './hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from './hosted-review-git-options'

async function isGitHubAuthenticated(
  repoPath: string,
  connectionId: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  // Why: a non-null enterprise slug already means gh is authenticated there, so skip a redundant probe (#8312).
  if (await getEnterpriseGitHubRepoSlug(repoPath, connectionId, options)) {
    return true
  }
  await acquire()
  try {
    // Why: `host` scopes any rate-limit breaker trip to github.com — the host
    // this probe actually targets — instead of a GH_HOST-derived scope.
    await ghExecFileAsync(
      ['auth', 'status', '--hostname', 'github.com'],
      connectionId
        ? { host: 'github.com' }
        : { cwd: repoPath, ...getHostedReviewLocalGitOptions(options), host: 'github.com' }
    )
    return true
  } catch {
    return false
  } finally {
    release()
  }
}

async function isGitLabAuthenticated(
  repoPath: string,
  connectionId: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  const projectRef = await getProjectSlug(repoPath, connectionId, options)
  if (!projectRef) {
    return false
  }
  await acquireGlab()
  try {
    await glabExecFileAsync(['auth', 'status', '--hostname', projectRef.host], {
      ...glabRepoExecOptions(repoPath, connectionId),
      ...(connectionId ? {} : getHostedReviewLocalGitOptions(options))
    })
    return true
  } catch {
    return false
  } finally {
    releaseGlab()
  }
}

export function reviewCopy(provider: HostedReviewProvider): {
  shortLabel: 'PR' | 'MR'
  reviewLabel: 'pull request' | 'merge request'
  providerName: string
  authInstruction: string
} {
  if (provider === 'gitlab') {
    return {
      shortLabel: 'MR',
      reviewLabel: 'merge request',
      providerName: 'GitLab',
      authInstruction: 'Run glab auth login'
    }
  }
  if (provider === 'azure-devops') {
    return {
      shortLabel: 'PR',
      reviewLabel: 'pull request',
      providerName: 'Azure DevOps',
      authInstruction: 'Set ORCA_AZURE_DEVOPS_TOKEN'
    }
  }
  if (provider === 'gitea') {
    return {
      shortLabel: 'PR',
      reviewLabel: 'pull request',
      providerName: 'Gitea',
      authInstruction: 'Set ORCA_GITEA_TOKEN'
    }
  }
  if (provider === 'bitbucket') {
    return {
      shortLabel: 'PR',
      reviewLabel: 'pull request',
      providerName: 'Bitbucket',
      authInstruction: 'Connect Bitbucket in Settings > Integrations'
    }
  }
  return {
    shortLabel: 'PR',
    reviewLabel: 'pull request',
    providerName: 'GitHub',
    authInstruction: 'Run gh auth login'
  }
}

export async function isProviderAuthenticated(
  provider: HostedReviewCreationProvider,
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> {
  if (provider === 'azure-devops') {
    return isAzureDevOpsReviewCreationAuthenticated()
  }
  if (provider === 'gitea') {
    return isGiteaReviewCreationAuthenticated()
  }
  if (provider === 'bitbucket') {
    // Why: falling through to the GitHub check made Create PR unusable for
    // anyone with Bitbucket connected but no `gh auth login`.
    return isBitbucketReviewCreationAuthenticated()
  }
  // Only the CLI-backed probes read a host: `gh` and `glab` run here, and the SSH target only
  // routes the git reads under them. The token-backed forges never touch the repository at all.
  const connectionId = hostedReviewSshConnectionId(executionHostId)
  if (provider === 'gitlab') {
    return isGitLabAuthenticated(repoPath, connectionId, options)
  }
  return isGitHubAuthenticated(repoPath, connectionId, options)
}
