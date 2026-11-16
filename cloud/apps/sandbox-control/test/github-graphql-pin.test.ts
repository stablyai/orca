// GH-AS-MEMBER: which GraphQL requests may carry a member's own token (parsed, never regex).
import { describe, expect, it } from 'vitest'
import { classifyGraphqlRequest, repositoryIdOfNode } from '../src/github-graphql-pin'

const req = (query: string, variables?: unknown, operationName?: string) => JSON.stringify({ query, ...(variables ? { variables } : {}), ...(operationName ? { operationName } : {}) })

describe('classifyGraphqlRequest', () => {
  it('gh pr create (variables): a member request naming the repository', () => {
    const body = req(
      'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }',
      { input: { repositoryId: 'R_repo', baseRefName: 'main', headRefName: 'f', title: 't' } }
    )
    expect(classifyGraphqlRequest(body)).toMatchObject({ member: true, targets: [{ kind: 'repository', id: 'R_repo' }] })
  })

  it('inline literals, aliases and fragments on Mutation are all read', () => {
    const body = req(`
      mutation { x: addComment(input: { subjectId: "PR_1", body: "hi" }) { clientMutationId } ...More }
      fragment More on Mutation { ... on Mutation { y: updatePullRequest(input: { pullRequestId: "PR_2" }) { clientMutationId } } }`)
    expect(classifyGraphqlRequest(body)).toMatchObject({ member: true, targets: [{ kind: 'node', id: 'PR_1' }, { kind: 'node', id: 'PR_2' }] })
  })

  it('anything else stays on the installation token', () => {
    const cases: [string, string][] = [
      [req('query { viewer { login } }'), 'not_a_mutation'],
      [req('mutation { createPullRequest(input: {repositoryId: "R"}) { clientMutationId } deleteRepository(input: {repositoryId: "R"}) { clientMutationId } }'), 'mutation_not_allowlisted'],
      [req('mutation { addComment(input: {subjectId: "PR_1"}) @include(if: true) { clientMutationId } }'), 'directives'],
      [req('mutation A { addComment(input: {subjectId: "X"}) { clientMutationId } } mutation B { addComment(input: {subjectId: "Y"}) { clientMutationId } }'), 'ambiguous_operation'],
      [req('mutation { addComment(input: {body: "no target"}) { clientMutationId } }'), 'no_target'],
      [req('mutation ($i: AddCommentInput!) { addComment(input: $i) { clientMutationId } }'), 'unresolved_input'],
      [req('mutation { addComment(input: {subjectId: "PR_1"}) { ...F } } fragment F on Query { viewer { login } }'), 'member'],
      [req('mutation { ... on Query { addComment(input: {subjectId: "PR_1"}) { clientMutationId } } }'), 'fragment_type'],
      [req('this is { not graphql'), 'unparsable'],
      ['not json', 'unreadable_body'],
      // Review M1: an omitted variable with a default would be invisible here but applied by GitHub.
      [req('mutation ($pr: ID = "PR_other") { addPullRequestReviewThread(input: { pullRequestReviewId: "PRR_in", pullRequestId: $pr }) { clientMutationId } }'), 'variable_defaults'],
      // Review L3: owner-level Projects reach outside the repository.
      [req('mutation { updatePullRequest(input: { pullRequestId: "PR_1", projectIds: ["P"] }) { clientMutationId } }'), 'outside_repo_input'],
      // Review L4: repeated top-level keys.
      ['{"query":"mutation { addComment(input: {subjectId: \\"PR_1\\"}) { clientMutationId } }","query":"query { viewer { login } }"}', 'duplicate_keys']
    ]
    for (const [body, reason] of cases) {
      const verdict = classifyGraphqlRequest(body)
      if (reason === 'member') {
        // A fragment inside the result selection is the response shape, not a root field: still one target.
        expect(verdict).toMatchObject({ member: true, targets: [{ kind: 'node', id: 'PR_1' }] })
      } else {
        expect(verdict).toEqual({ member: false, reason })
      }
    }
  })

  it('with several operations, the named one is the one read', () => {
    const body = req('query Q { viewer { login } } mutation M($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { clientMutationId } }', { id: 'PR_9' }, 'M')
    expect(classifyGraphqlRequest(body)).toMatchObject({ member: true, targets: [{ kind: 'node', id: 'PR_9' }] })
    expect(classifyGraphqlRequest(req('query Q { viewer { login } } mutation M { x }', undefined, 'Q'))).toEqual({ member: false, reason: 'not_a_mutation' })
  })
})

describe('repositoryIdOfNode', () => {
  it('reads a PR/issue/comment repository, or a review’s pull request’s', () => {
    expect(repositoryIdOfNode({ data: { node: { __typename: 'PullRequest', repository: { id: 'R' } } } })).toBe('R')
    expect(repositoryIdOfNode({ data: { node: { __typename: 'PullRequestReview', pullRequest: { repository: { id: 'R2' } } } } })).toBe('R2')
    expect(repositoryIdOfNode({ data: { node: null } })).toBeNull()
    expect(repositoryIdOfNode({ errors: [{}] })).toBeNull()
  })
})
