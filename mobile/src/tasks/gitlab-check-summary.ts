import {
  mapGitLabPipelineJobStatusToCheckStatus,
  mapGitLabPipelineJobStatusToConclusion
} from '../../../src/shared/gitlab-pipeline-checks'
import { summarizeProviderChecks } from '../../../src/shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/github/pull-request-types'

type GitLabPipelineJobLike = { status: string }

export function buildGitLabCheckSummary(jobs: GitLabPipelineJobLike[]): ProviderCheckSummary {
  return summarizeProviderChecks(
    jobs.map((job) => ({
      status: mapGitLabPipelineJobStatusToCheckStatus(job.status),
      conclusion: mapGitLabPipelineJobStatusToConclusion(job.status)
    }))
  )
}
