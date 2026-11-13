import { z } from 'zod'
import type { CommunityCandidatePlan } from '../../shared/community-candidates'
type CandidateApi = (path: string, init?: RequestInit) => Promise<unknown>
const sha = z.string().regex(/^[a-f0-9]{40}$/)
export async function createCommunityReviewBranch(
  api: CandidateApi,
  repository: string,
  plan: CommunityCandidatePlan
): Promise<{ repository: string; commit: string; branch: string }> {
  const branch = `orca-community/${plan.id}`
  let current = plan.customSource?.commit ?? plan.baseSha
  await api(`repos/${repository}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: current })
  })
  for (const head of [plan.baseSha, ...plan.additions.map((pr) => pr.headSha)]) {
    if (head === current) {
      continue
    }
    const response = await api(`repos/${repository}/merges`, {
      method: 'POST',
      body: JSON.stringify({
        base: branch,
        head,
        commit_message: `Combine pinned Orca source for Community plan ${plan.id}`
      })
    })
    if (response === null) {
      continue
    }
    const merge = z.object({ sha, parents: z.array(z.object({ sha })) }).parse(response)
    if (
      merge.parents.length !== 2 ||
      merge.parents[0].sha !== current ||
      merge.parents[1].sha !== head
    ) {
      throw new Error('The review branch changed outside this plan. Prepare a new candidate.')
    }
    current = merge.sha
  }
  return { repository, commit: current, branch }
}
