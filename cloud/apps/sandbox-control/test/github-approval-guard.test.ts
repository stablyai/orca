// APPROVALS-REFUSED: what counts as an approval on api.github.com, fail-closed on anything unclear.
import { describe, expect, it } from 'vitest'
import { graphqlApproves, requestApproves, unnormalizedWrite } from '../src/github-approval-guard'

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
      'not json addPullRequestReview APPROVE',
      // Review G3: unreadable is refused (a gzip body never parses); an unparsable query naming a review mutation too,
      // its event may be in the variables.
      '\u001f\u008b\u0008binary',
      gql('mutation M($i: X!) { addPullRequestReview(input: $i) { clientMutationId } ', { i: { pullRequestId: 'P', event: 'APPROVE' } }),
      // Unreadable in other ways: no query string, oversized, a batch entry without a query.
      JSON.stringify({ variables: {} }),
      gql(`query { viewer { login } } # ${'x'.repeat(300 * 1024)}`),
      JSON.stringify([{ query: 'query { viewer { login } }' }, { notAQuery: 1 }]),
      // Branch protection and rulesets.
      gql('mutation { updateBranchProtectionRule(input: { branchProtectionRuleId: "B", requiredApprovingReviewCount: 0 }) { clientMutationId } }'),
      gql('mutation { deleteRepositoryRuleset(input: { repositoryRulesetId: "R" }) { clientMutationId } }'),
      // Review G4: dismissing a review unblocks a merge.
      gql('mutation { dismissPullRequestReview(input: { pullRequestReviewId: "R", message: "x" }) { clientMutationId } }')
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

describe('review G2 and G4: unnormalized write paths; approval-shaped REST actions', () => {
  it('a write with escapes, empty or dot segments is refused before any check; reads are untouched', () => {
    for (const path of ['/repos/o/r/pulls/7/reviews;x', '/repos/o/r/pulls/7/%72eviews', '/x/%2e%2e/repos/o/r/pulls/7/reviews', '//repos/o/r/pulls/7/reviews', '/repos/o/r/./pulls/7/reviews', '/repos/o/r/../r/pulls/7/reviews']) {
      expect(unnormalizedWrite('POST', path), path).toBe(true)
    }
    expect(unnormalizedWrite('GET', '/repos/o/r/%2e%2e')).toBe(false)
    expect(unnormalizedWrite('POST', '/repos/o/r/issues/7/comments?x=%20')).toBe(false)
  })

  it('dismissals, fork-run approvals and environment approvals are refused; repository-id routes are covered', () => {
    expect(requestApproves({ method: 'PUT', path: '/repos/o/r/pulls/7/reviews/9/dismissals', body: '{}' })).toBe(true)
    for (const [method, path] of [
      ['PUT', '/repos/o/r/branches/main/protection'],
      ['DELETE', '/repos/o/r/branches/main/protection/required_pull_request_reviews'],
      ['PATCH', '/repos/o/r/branches/main/protection/required_pull_request_reviews'],
      ['POST', '/repos/o/r/rulesets'],
      ['PUT', '/repos/o/r/rulesets/4']
    ] as const) {
      expect(requestApproves({ method, path, body: '{}' }), path).toBe(true)
    }
    expect(requestApproves({ method: 'GET', path: '/repos/o/r/branches/main/protection', body: null })).toBe(false)
    expect(requestApproves({ method: 'POST', path: '/repos/o/r/actions/runs/5/approve', body: null })).toBe(true)
    expect(requestApproves({ method: 'POST', path: '/repos/o/r/actions/runs/5/pending_deployments', body: JSON.stringify({ state: 'approved', environment_ids: [1] }) })).toBe(true)
    expect(requestApproves({ method: 'POST', path: '/repos/o/r/actions/runs/5/pending_deployments', body: JSON.stringify({ state: 'rejected', environment_ids: [1] }) })).toBe(false)
    expect(requestApproves({ method: 'POST', path: '/repositories/123/pulls/7/reviews', body: JSON.stringify({ event: 'APPROVE' }) })).toBe(true)
    expect(requestApproves({ method: 'POST', path: '/GraphQL', body: gql('mutation { addPullRequestReview(input: { pullRequestId: "P", event: APPROVE }) { clientMutationId } }') })).toBe(true)
  })
})

