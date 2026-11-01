import {
  gitLabPipelineJobsToPRChecks,
  mapGitLabPipelineJobStatusToCheckStatus,
  mapGitLabPipelineJobStatusToConclusion
} from '../../../src/shared/gitlab-pipeline-checks'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/github/pull-request-types'
import type { GitLabPipeline } from '../../../src/shared/gitlab-types'

type GitLabPipelineJobLike = { status: string }

export function buildGitLabCheckSummary(
  jobs: GitLabPipelineJobLike[],
  pipeline?: GitLabPipeline
): ProviderCheckSummary {
  if (jobs.length === 0) {
    return summarizeProviderChecks(gitLabPipelineJobsToPRChecks([], pipeline))
  }
  return summarizeProviderChecks(
    jobs.map((job) => ({
      status: mapGitLabPipelineJobStatusToCheckStatus(job.status),
      conclusion: mapGitLabPipelineJobStatusToConclusion(job.status)
    }))
  )
}
