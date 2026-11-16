// APPROVALS-REFUSED: what counts as an approval on api.github.com, fail-closed on anything unclear.
import { describe, expect, it } from 'vitest'
import { graphqlApproves, requestApproves } from '../src/github-approval-guard'

const gql = (query: string, variables?: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ query, ...(variables ? { variables } : {}), ...extra })

describe('GraphQL approvals', () => {
  it('finds an approval however it is written', () => {
    for (const body of [
      gql('mutation { addPullRequestReview(input: { pullRequestId: "P", event: APPROVE }) { clientMutationId } }'),
      gql('mutation { a: submitPullRequestReview(input: { pullRequestReviewId: "R", event: APPROVE }) { clientMutationId } }'),
      gql('mutation M($i: AddPullRequestReviewInput!) { addPullRequestReview(input: $i) { clientMutationId } }', { i: { pullRequestId: 'P', event: 'approve' } }),
      gql('mutation M($e: PullRequestReviewEvent) { addPullRequestReview(input: { pullRequestId: "P", event: $e }) { clientMutationId } }', { e: 'APPROVE' }),
      // A variable's default is its value when none is sent.
      gql('mutation M($e: PullRequestReviewEvent = APPROVE) { addPullRequestReview(input: { pullRequestId: "P", event: $e }) { clientMutationId } }'),
      // Fragments and inline fragments on Mutation.
      gql('mutation { ...F } fragment F on Mutation { addPullRequestReview(input: { pullRequestId: "P", event: APPROVE }) { clientMutationId } }'),
      gql('mutation { ... on Mutation { submitPullRequestReview(input: { pullRequestReviewId: "R", event: APPROVE }) { clientMutationId } } }'),
      // Two operations, operationName naming the harmless one: still refused.
      gql('query Q { viewer { login } } mutation M { addPullRequestReview(input: { pullRequestId: "P", event: APPROVE }) { clientMutationId } }', undefined, { operationName: 'Q' }),
      // Batched.
      JSON.stringify([{ query: 'query { viewer { login } }' }, { query: 'mutation { addPullRequestReview(input: { pullRequestId: "P", event: APPROVE }) { clientMutationId } }' }]),
      // Unresolvable: an input variable that isn't sent, a submission with no event, unparsable text mentioning approve.
      gql('mutation M($i: AddPullRequestReviewInput!) { addPullRequestReview(input: $i) { clientMutationId } }'),
      gql('mutation { submitPullRequestReview(input: { pullRequestReviewId: "R" }) { clientMutationId } }'),
      gql('mutation { addPullRequestReview(input: { pullRequestId: "P", event: APPROVE }'),
      'not json addPullRequestReview APPROVE'
    ]) {
      expect(graphqlApproves(body), body).toBe(true)
    }
  })

  it('leaves everything else alone', () => {
    for (const body of [
      gql('query { viewer { login } }'),
      gql('mutation { addPullRequestReview(input: { pullRequestId: "P", event: COMMENT, body: "I approve of this" }) { clientMutationId } }'),
      gql('mutation { addPullRequestReview(input: { pullRequestId: "P", event: REQUEST_CHANGES }) { clientMutationId } }'),
      // A pending review (no event) isn't an approval; its submission is checked when it's sent.
      gql('mutation { addPullRequestReview(input: { pullRequestId: "P" }) { clientMutationId } }'),
      gql('mutation { addComment(input: { subjectId: "P", body: "approve" }) { clientMutationId } }'),
      gql('query { repository(owner: "a", name: "b") { pullRequest(number: 1) { reviewDecision } } }')
    ]) {
      expect(graphqlApproves(body), body).toBe(false)
    }
  })
})

describe('REST approvals', () => {
  it('a review or a submission with APPROVE, any case or path shape; unreadable counts', () => {
    const post = (path: string, body: string | null) => requestApproves({ method: 'POST', path, body })
    expect(post('/repos/a/b/pulls/1/reviews', JSON.stringify({ event: 'APPROVE' }))).toBe(true)
    expect(post('/repos/a/b/pulls/1/reviews/9/events', JSON.stringify({ event: 'approve' }))).toBe(true)
    expect(post('/repos/a/b/Pulls/1/Reviews/', JSON.stringify({ event: 'Approve' }))).toBe(true)
    expect(post('/repos/a/b/pulls/1/reviews?x=1', '{not json')).toBe(true)
    expect(post('/repos/a/b/pulls/1/reviews', null)).toBe(true)
    expect(post('/repos/a/b/pulls/1/reviews', JSON.stringify({ event: 'COMMENT', body: 'approve' }))).toBe(false)
    expect(post('/repos/a/b/pulls/1/reviews', JSON.stringify({ body: 'pending' }))).toBe(false)
    expect(post('/repos/a/b/issues/1/comments', JSON.stringify({ body: 'APPROVE' }))).toBe(false)
    expect(requestApproves({ method: 'GET', path: '/repos/a/b/pulls/1/reviews', body: null })).toBe(false)
  })
})
