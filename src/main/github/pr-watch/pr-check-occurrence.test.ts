import { describe, expect, it } from 'vitest'
import { restPRCheckRollupRows } from '../client/check/rest-pr-check-pages'
import { evaluatePRCheckOccurrence, type PRCheckContextState } from './pr-check-occurrence'

// Provider-shaped reads of one commit: GraphQL statusCheckRollup nodes and the REST check-runs and
// status endpoints, with the fields each returns (REST rows trimmed of fields the reader ignores).
const graphqlRun = (id: number, conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name: 'build',
  databaseId: id,
  status,
  conclusion,
  checkSuite: { databaseId: 29001 }
})
const graphqlStatus = (state: string, run: number) => ({
  __typename: 'StatusContext',
  context: 'ci/circleci: test',
  state,
  targetUrl: `https://circleci.com/gh/acme/repo/${run}`,
  createdAt: '2026-11-06T10:00:00Z'
})
const restRun = (id: number, conclusion: string | null, status = 'completed') => ({
  id,
  name: 'build',
  head_sha: '8d5f74b3c0e1',
  status,
  conclusion,
  html_url: `https://github.com/acme/repo/runs/${id}`,
  details_url: `https://github.com/acme/repo/actions/runs/101/job/${id}`,
  started_at: '2026-11-06T10:00:00Z',
  completed_at: status === 'completed' ? '2026-11-06T10:04:00Z' : null,
  check_suite: { id: 29001 }
})
const restStatus = (state: string, run: number) => ({
  context: 'ci/circleci: test',
  state,
  target_url: `https://circleci.com/gh/acme/repo/${run}`,
  created_at: '2026-11-06T10:00:00Z'
})

function after(
  rollup: unknown[],
  prior: ReadonlyMap<string, PRCheckContextState> = new Map()
): { verdict: string | null; next: Map<string, PRCheckContextState> } {
  const evaluation = evaluatePRCheckOccurrence(rollup, true, prior)
  return {
    verdict: evaluation.verdict,
    next: new Map(evaluation.contexts.map((row) => [row.context, row]))
  }
}

describe('evaluatePRCheckOccurrence', () => {
  it('reports a final head once, and again for a rerun nobody saw running', () => {
    const red = after([graphqlRun(31001, 'FAILURE'), graphqlStatus('SUCCESS', 101)])
    expect(red.verdict).toBe('failure')
    expect(
      after([graphqlRun(31001, 'FAILURE'), graphqlStatus('SUCCESS', 101)], red.next).verdict
    ).toBe(null)
    // A rerun is a new check run; failing again is still a new result.
    const rerun = after([graphqlRun(31002, 'FAILURE'), graphqlStatus('SUCCESS', 101)], red.next)
    expect(rerun.verdict).toBe('failure')
    expect(
      after([graphqlRun(31003, 'SUCCESS'), graphqlStatus('SUCCESS', 101)], rerun.next).verdict
    ).toBe('success')
  })

  it('counts a stable-URL status that went pending again, but not an identical re-post', () => {
    const green = after([graphqlStatus('SUCCESS', 101)])
    expect(green.verdict).toBe('success')
    expect(after([graphqlStatus('SUCCESS', 101)], green.next).verdict).toBe(null)
    const running = evaluatePRCheckOccurrence([graphqlStatus('PENDING', 101)], true, green.next)
    expect(running.verdict).toBe(null)
    const runningRows = new Map(running.contexts.map((row) => [row.context, row]))
    expect(after([graphqlStatus('SUCCESS', 101)], runningRows).verdict).toBe('success')
    // The same final state under a new run URL is a new run.
    expect(after([graphqlStatus('SUCCESS', 102)], green.next).verdict).toBe('success')
  })

  it('reports nothing until every check is final, and nothing for cancellation or approval', () => {
    expect(after([graphqlStatus('EXPECTED', 101)]).verdict).toBe(null)
    expect(after([]).verdict).toBe(null)
    expect(
      after([graphqlRun(31001, null, 'IN_PROGRESS'), graphqlStatus('FAILURE', 101)]).verdict
    ).toBe(null)
    expect(after([graphqlRun(31001, 'CANCELLED')]).verdict).toBe(null)
    expect(
      evaluatePRCheckOccurrence([graphqlRun(31001, 'SUCCESS')], false, new Map()).verdict
    ).toBe(null)
    const awaitingApproval = restPRCheckRollupRows(
      [restRun(31001, 'success')],
      [],
      [{ id: 29002, status: 'completed', conclusion: 'action_required' }]
    )
    expect(after(awaitingApproval).verdict).toBe(null)
  })

  it('gives the GraphQL and REST reads of one commit the same identity and verdict', () => {
    const graphql = [graphqlRun(31001, 'FAILURE'), graphqlStatus('SUCCESS', 101)]
    const rest = restPRCheckRollupRows(
      [restRun(31001, 'failure')],
      [restStatus('success', 101)],
      []
    )
    const fromGraphql = after(graphql)
    const fromRest = after(rest)
    expect(fromRest.verdict).toBe(fromGraphql.verdict)
    expect([...fromRest.next.values()]).toEqual([...fromGraphql.next.values()])
    // Either read after the other sees nothing new; a REST rerun is new to a GraphQL memory.
    expect(after(rest, fromGraphql.next).verdict).toBe(null)
    expect(
      after(
        restPRCheckRollupRows([restRun(31002, 'failure')], [restStatus('success', 101)], []),
        fromGraphql.next
      ).verdict
    ).toBe('failure')
  })
})
