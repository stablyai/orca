import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import type { HostedReviewProvider } from '../../shared/source-control/hosted-review/hosted-review-contracts'
import type { HostedReviewCreationProvider } from '../../shared/source-control/hosted-review/hosted-review-creation-providers'
import {
  getAzureDevOpsAuthMethod,
  resolveAzureDevOpsCredentials
} from '../azure-devops/azure-devops-credentials'
import { AzureDevOpsAuthError } from '../azure-devops/azure-cli-access-token'
import { isBitbucketReviewCreationAuthenticated } from '../bitbucket/pull-request-creation'
import { isGiteaReviewCreationAuthenticated } from '../gitea/pull-request-creation'
import { getEnterpriseGitHubRepoSlug } from '../github/repositories/github-enterprise-repository'
import { acquire, release } from '../github/execution/github-operation-slots'
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { getProjectSlug } from '../gitlab/merge-requests/merge-request-lookup'
import {
  acquire as acquireGlab,
  release as releaseGlab
} from '../gitlab/requests/glab-request-admission'
import { glabExecFileAsync } from '../git/command-runner/hosted-cli/glab-exec-file'
import { glabRepoExecOptions } from '../gitlab/projects/gitlab-project-ref-resolution'
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
  // Enterprise resolution already proved host authentication; avoid a redundant probe (#8312).
  if (await getEnterpriseGitHubRepoSlug(repoPath, connectionId, options)) {
    return true
  }
  await acquire()
  try {
    // Scope rate-limit breaker to the probed github.com host, independent of GH_HOST.
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
      authInstruction:
        getAzureDevOpsAuthMethod() === 'azure-cli'
          ? 'Run az login, then Re-check Azure DevOps in Settings > Integrations'
          : 'Set ORCA_AZURE_DEVOPS_TOKEN'
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
    try {
      return (await resolveAzureDevOpsCredentials()).credentialAvailable
    } catch (error) {
      if (error instanceof AzureDevOpsAuthError) {
        return false
      }
      throw error
    }
  }
  if (provider === 'gitea') {
    return isGiteaReviewCreationAuthenticated()
  }
  if (provider === 'bitbucket') {
    // Bitbucket authentication must not fall through to GitHub login requirements.
    return isBitbucketReviewCreationAuthenticated()
  }
  // Only CLI-backed providers need host-routed Git reads; their CLIs run here. Token-backed providers do not touch the repo.
  const connectionId = hostedReviewSshConnectionId(executionHostId)
  if (provider === 'gitlab') {
    return isGitLabAuthenticated(repoPath, connectionId, options)
  }
  return isGitHubAuthenticated(repoPath, connectionId, options)
}
