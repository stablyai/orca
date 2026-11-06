import { describe, expect, it } from 'vitest'
import {
  mapGraphQLPRChecksResponse,
  mapRestCheckRun,
  mapRestCommitStatus
} from './pr-checks-response-mapping'

const repo = { owner: 'acme', repo: 'widgets' }

function rollup(contexts: unknown[]) {
  return {
    data: {
      repository: {
        pullRequest: {
          headRefOid: 'a'.repeat(40),
          commits: {
            nodes: [
              {
                commit: {
                  oid: 'a'.repeat(40),
                  statusCheckRollup: { contexts: { nodes: contexts } }
                }
              }
            ]
          }
        }
      }
    }
  }
}

describe('check run times', () => {
  it('carries when each GraphQL check ran, dropping GitHub’s unset zero time', () => {
    const checks = mapGraphQLPRChecksResponse(
      repo,
      rollup([
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          startedAt: '2026-11-05T10:00:00Z',
          completedAt: '2026-11-05T10:03:12Z'
        },
        {
          __typename: 'CheckRun',
          name: 'lint',
          status: 'QUEUED',
          conclusion: null,
          startedAt: '0001-01-01T00:00:00Z',
          completedAt: null
        },
        {
          __typename: 'StatusContext',
          context: 'jenkins',
          state: 'FAILURE',
          createdAt: '2026-11-05T09:00:00Z'
        },
        {
          __typename: 'StatusContext',
          context: 'deploy',
          state: 'PENDING',
          createdAt: '2026-11-05T09:30:00Z'
        }
      ])
    )
    expect(
      checks?.map(({ name, startedAt, completedAt }) => ({ name, startedAt, completedAt }))
    ).toEqual([
      { name: 'build', startedAt: '2026-11-05T10:00:00Z', completedAt: '2026-11-05T10:03:12Z' },
      { name: 'lint', startedAt: undefined, completedAt: undefined },
      // A commit status's one time is when its result was posted; a pending one has no run yet.
      { name: 'jenkins', startedAt: undefined, completedAt: '2026-11-05T09:00:00Z' },
      { name: 'deploy', startedAt: undefined, completedAt: undefined }
    ])
  })

  it('carries REST check-run and commit-status times', () => {
    expect(
      mapRestCheckRun({
        name: 'build',
        status: 'in_progress',
        conclusion: null,
        html_url: '',
        details_url: null,
        started_at: '2026-11-05T10:00:00Z',
        completed_at: null
      })
    ).toMatchObject({ startedAt: '2026-11-05T10:00:00Z' })
    expect(
      mapRestCommitStatus({
        context: 'jenkins',
        state: 'success',
        created_at: '2026-11-05T09:00:00Z'
      })
    ).toMatchObject({ completedAt: '2026-11-05T09:00:00Z' })
  })
})
