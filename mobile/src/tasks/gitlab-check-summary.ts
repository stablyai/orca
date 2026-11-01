import {
  gitLabPipelineToPRCheck,
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
  // The parent pipeline is the verdict: one page of jobs cannot prove a failed pipeline passed.
  if (pipeline) {
    return {
      ...summarizeProviderChecks([gitLabPipelineToPRCheck(pipeline)]),
      scope: 'pipeline'
    }
  }
  return summarizeProviderChecks(
    jobs.map((job) => ({
      status: mapGitLabPipelineJobStatusToCheckStatus(job.status),
      conclusion: mapGitLabPipelineJobStatusToConclusion(job.status)
    }))
  )
}
