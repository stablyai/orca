import { describe, expect, it } from 'vitest'
import { deriveGitHubCheckSummary, selectLatestGitHubCheckContexts } from './github-check-rollup'

function checkRun(
  name: string,
  conclusion: string,
  startedAt?: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    startedAt,
    workflowName: 'CI',
    ...overrides
  }
}

describe('selectLatestGitHubCheckContexts', () => {
  it('keeps the newest check run for each stable context', () => {
    const oldFailure = checkRun('merge-label', 'FAILURE', '2026-07-22T02:08:00Z')
    const latestSuccess = checkRun('merge-label', 'SUCCESS', '2026-07-22T02:21:00Z')

    expect(selectLatestGitHubCheckContexts([latestSuccess, oldFailure])).toEqual([latestSuccess])
  })

  it('uses the later input when timestamps are absent or equal', () => {
    const noTimeFailure = checkRun('build', 'FAILURE')
    const noTimeSuccess = checkRun('build', 'SUCCESS')
    const equalTimeFailure = checkRun('lint', 'FAILURE', '2026-07-22T03:00:00Z')
    const equalTimeSuccess = checkRun('lint', 'SUCCESS', '2026-07-22T03:00:00Z')

    expect(
      selectLatestGitHubCheckContexts([
        noTimeFailure,
        noTimeSuccess,
        equalTimeFailure,
        equalTimeSuccess
      ])
    ).toEqual([noTimeSuccess, equalTimeSuccess])
  })

  it('keeps check runs from different apps separate', () => {
    const actionsBuild = checkRun('build', 'SUCCESS', '2026-07-22T03:00:00Z', {
      workflowName: 'CI',
      checkSuite: { app: { slug: 'github-actions' } }
    })
    const externalBuild = checkRun('build', 'SUCCESS', '2026-07-22T03:02:00Z', {
      workflowName: 'CI',
      checkSuite: { app: { slug: 'external-ci' } }
    })

    expect(selectLatestGitHubCheckContexts([actionsBuild, externalBuild])).toEqual([
      actionsBuild,
      externalBuild
    ])
  })

  it('uses the workflow as the provider fallback when app metadata is unavailable', () => {
    const ciBuild = checkRun('build', 'SUCCESS', '2026-07-22T03:00:00Z')
    const releaseBuild = checkRun('build', 'SUCCESS', '2026-07-22T03:01:00Z', {
      workflowName: 'Release'
    })

    expect(selectLatestGitHubCheckContexts([ciBuild, releaseBuild])).toEqual([
      ciBuild,
      releaseBuild
    ])
  })

  it('does not merge legacy statuses with check runs sharing a display name', () => {
    const run = checkRun('build', 'SUCCESS', '2026-07-22T03:00:00Z')
    const status = {
      __typename: 'StatusContext',
      context: 'build',
      state: 'FAILURE',
      createdAt: '2026-07-22T03:01:00Z'
    }

    expect(selectLatestGitHubCheckContexts([run, status])).toEqual([run, status])
  })

  it('keeps unrecognized entries instead of dropping their pending signal', () => {
    expect(selectLatestGitHubCheckContexts([null, { status: 'QUEUED' }, 'unknown'])).toEqual([
      null,
      { status: 'QUEUED' },
      'unknown'
    ])
  })
})

describe('deriveGitHubCheckSummary', () => {
  it('counts only the latest result after repeated fail and pass cycles', () => {
    const summary = deriveGitHubCheckSummary([
      checkRun('merge-label', 'FAILURE', '2026-07-22T02:08:00Z'),
      checkRun('merge-label', 'SUCCESS', '2026-07-22T02:21:00Z'),
      checkRun('merge-label', 'FAILURE', '2026-07-22T02:30:00Z'),
      checkRun('merge-label', 'SUCCESS', '2026-07-22T02:42:00Z'),
      checkRun('lint', 'SUCCESS', '2026-07-22T02:10:00Z')
    ])

    expect(summary).toEqual({ state: 'success', total: 2, passed: 2, failed: 0, pending: 0 })
  })

  it('accepts the GraphQL rollup wrapper and deduplicates legacy statuses', () => {
    const summary = deriveGitHubCheckSummary({
      contexts: {
        nodes: [
          {
            __typename: 'StatusContext',
            context: 'jenkins',
            state: 'FAILURE',
            createdAt: '2026-07-22T02:08:00Z'
          },
          {
            __typename: 'StatusContext',
            context: 'jenkins',
            state: 'SUCCESS',
            createdAt: '2026-07-22T02:21:00Z'
          }
        ]
      }
    })

    expect(summary).toEqual({ state: 'success', total: 1, passed: 1, failed: 0, pending: 0 })
  })
})
