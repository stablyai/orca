import { buildGitHubCheckSummary, type GitHubCheckLike } from './github-check-summary'
import type { ProviderCheckSummary } from '../../../src/shared/types'

type GitLabPipelineJobLike = { status: string }

export function buildGitLabCheckSummary(jobs: GitLabPipelineJobLike[]): ProviderCheckSummary {
  return buildGitHubCheckSummary(
    jobs.map((job): GitHubCheckLike => {
      const status = job.status.toLowerCase()
      const nonterminal = [
        'created',
        'pending',
        'scheduled',
        'waiting_for_callback',
        'waiting_for_resource',
        'preparing'
      ].includes(status)
      return {
        status: status === 'running' ? 'in_progress' : nonterminal ? 'queued' : 'completed',
        conclusion:
          status === 'success'
            ? 'success'
            : status === 'failed'
              ? 'failure'
              : ['canceled', 'canceling'].includes(status)
                ? 'cancelled'
                : status === 'skipped'
                  ? 'skipped'
                  : ['manual', 'action_required'].includes(status)
                    ? 'action_required'
                    : status === 'running' || nonterminal
                      ? 'pending'
                      : null
      }
    })
  )
}
