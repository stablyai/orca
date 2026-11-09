import { describe, expect, it } from 'vitest'
import '../client/check/rest-pr-check-pages'
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
})
