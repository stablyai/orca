import { z } from 'zod'
import type { CommunityGitHubSource } from './community-github-source'
export type CommunityReviewFacts = {
  memberReviewed: boolean | null
  memberApproved: boolean | null
  reviewed: boolean | null
  approved: boolean | null
  maintainerReviewed: boolean | null
  maintainerApproved: boolean | null
}
const query = `query CommunityReviewEvidence($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest {
    number
    reviews(first: 100, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
      pageInfo { hasNextPage }
      nodes { state authorAssociation author { login } }
    }
  } }
}`
const result = z.object({
  nodes: z.array(
    z
      .object({
        number: z.number(),
        reviews: z.object({
          pageInfo: z.object({ hasNextPage: z.boolean() }),
          nodes: z.array(
            z
              .object({
                state: z.string(),
                authorAssociation: z.string(),
                author: z.object({ login: z.string() }).nullable()
              })
              .nullable()
          )
        })
      })
      .nullable()
  )
})
export async function communityReviewFacts(
  source: CommunityGitHubSource,
  ids: string[],
  maintainers: string[] | null,
  signal: AbortSignal
): Promise<Map<number, CommunityReviewFacts>> {
  const facts = new Map<number, CommunityReviewFacts>()
  const roles = new Set(maintainers?.map((name) => name.toLowerCase()))
  for (let offset = 0; offset < ids.length; offset += 50) {
    let response
    try {
      response = result.parse(
        await source.graphql(query, { ids: ids.slice(offset, offset + 50) }, signal)
      )
    } catch {
      break
    }
    for (const row of response.nodes) {
      if (!row) {
        continue
      }
      const reviews = row.reviews.nodes.filter((review) => review !== null)
      const complete = !row.reviews.pageInfo.hasNextPage
      const byMaintainers = reviews.filter(
        (review) => review.author && roles.has(review.author.login.toLowerCase())
      )
      if (!complete) {
        facts.set(row.number, {
          memberReviewed: null,
          memberApproved: null,
          reviewed: null,
          approved: null,
          maintainerReviewed: null,
          maintainerApproved: null
        })
        continue
      }
      const members = reviews.filter((review) =>
        ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.authorAssociation)
      )
      const reviewed = reviews.some((review) => review.state !== 'DISMISSED')
      const approved = reviews.some((review) => review.state === 'APPROVED')
      const maintainerReviewed = byMaintainers.some((review) => review.state !== 'DISMISSED')
      const maintainerApproved = byMaintainers.some((review) => review.state === 'APPROVED')
      facts.set(row.number, {
        memberReviewed: members.some((review) => review.state !== 'DISMISSED'),
        memberApproved: members.some((review) => review.state === 'APPROVED'),
        reviewed: reviewed || complete ? reviewed : null,
        approved: approved || complete ? approved : null,
        maintainerReviewed:
          maintainers && (maintainerReviewed || complete) ? maintainerReviewed : null,
        maintainerApproved:
          maintainers && (maintainerApproved || complete) ? maintainerApproved : null
      })
    }
  }
  return facts
}
