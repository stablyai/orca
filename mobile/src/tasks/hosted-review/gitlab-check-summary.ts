import {
  gitLabPipelineToPRCheck,
  gitLabPipelineJobOutcome
} from '../../../../src/shared/source-control/checks/gitlab/gitlab-pipeline-checks'
import { summarizeProviderChecks } from '../../../../src/shared/source-control/checks/provider-check-summary'
import type { ProviderCheckSummary } from '../../../../src/shared/github/pull-requests/pull-request-types'
import type { GitLabPipeline } from '../../../../src/shared/gitlab-types'

type GitLabPipelineJobLike = { status: string; allowFailure?: boolean }

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
  return summarizeProviderChecks(jobs.map(gitLabPipelineJobOutcome))
}
