import { z } from 'zod'
import type { CommunityCandidateRun } from '../../shared/community-candidates'
export async function findCommunityCandidateRun(
  saved: CommunityCandidateRun,
  api: (path: string) => Promise<unknown>
) {
  const response = z
    .object({
      workflow_runs: z.array(
        z.object({
          head_sha: z.string().regex(/^[a-f0-9]{40}$/),
          id: z.number(),
          display_title: z.string(),
          html_url: z.string().url(),
          status: z.string(),
          conclusion: z.string().nullable(),
          artifacts_url: z.string().url()
        })
      )
    })
    .parse(
      await api(
        `repos/${saved.repository}/actions/workflows/community-candidate.yml/runs?event=workflow_dispatch&per_page=100`
      )
    )
  return response.workflow_runs.find(
    (run) =>
      run.display_title === `Community ${saved.plan.id}` && run.head_sha === saved.workflowCommit
  )
}
