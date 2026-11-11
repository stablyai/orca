import { describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({ ghExecFileAsyncMock: vi.fn() }))

vi.mock('../../gh-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock,
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('../../rate-limit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  noteRepositoryRateLimitSpend: vi.fn()
}))
vi.mock('../lookup/pr-lookup-rate-limit', () => ({ assertRateLimitBudget: vi.fn() }))

import { getPRChecksViaRestFallback } from './get-pr-checks'

function forbidden(path: string): Error {
  return Object.assign(new Error(`Command failed: gh api ${path}`), {
    stderr: 'gh: Resource not accessible by personal access token (HTTP 403)\n',
    stdout: '{"message":"Resource not accessible by personal access token","status":"403"}'
  })
}

function reply(body: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(body), stderr: '' }
}

describe('PR checks for a token without the Checks permission', () => {
  it('lists the head commit Actions jobs when check runs are refused', async () => {
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const path = args.at(-1) ?? ''
      if (path.includes('/check-runs') || path.includes('/check-suites')) {
        throw forbidden(path)
      }
      if (path.includes('/actions/runs?head_sha=sha-1&')) {
        return reply({
          total_count: 2,
          workflow_runs: [
            { id: 7, check_suite_id: 70, status: 'completed', conclusion: 'failure' },
            { id: 8, check_suite_id: 80, status: 'completed', conclusion: 'action_required' }
          ]
        })
      }
      if (path.includes('/actions/runs/8/jobs?filter=latest&')) {
        return reply({ total_count: 0, jobs: [] })
      }
      if (path.includes('/actions/runs/7/jobs?filter=latest&')) {
        return reply({
          total_count: 2,
          jobs: [
            {
              id: 71,
              run_id: 7,
              name: 'pytest',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/acme/widgets/actions/runs/7/job/71'
            },
            {
              id: 72,
              run_id: 7,
              name: 'compose',
              status: 'queued',
              conclusion: null,
              html_url: 'https://github.com/acme/widgets/actions/runs/7/job/72'
            }
          ]
        })
      }
      if (path.includes('/status?')) {
        return reply({
          total_count: 1,
          statuses: [{ context: 'ci/jenkins', state: 'success', target_url: null }]
        })
      }
      throw new Error(`unexpected ${path}`)
    })

    const checks = await getPRChecksViaRestFallback(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'sha-1',
      { cwd: '/repo-root' }
    )

    expect(
      checks?.map(({ name, status, conclusion, url, checkRunId, workflowRunId }) => ({
        name,
        status,
        conclusion,
        url,
        checkRunId,
        workflowRunId
      }))
    ).toEqual([
      {
        name: 'pytest',
        status: 'completed',
        conclusion: 'failure',
        url: 'https://github.com/acme/widgets/actions/runs/7/job/71',
        checkRunId: 71,
        workflowRunId: 7
      },
      {
        name: 'compose',
        status: 'queued',
        conclusion: 'pending',
        url: 'https://github.com/acme/widgets/actions/runs/7/job/72',
        checkRunId: 72,
        workflowRunId: 7
      },
      {
        name: 'ci/jenkins',
        status: 'completed',
        conclusion: 'success',
        url: null,
        checkRunId: undefined,
        workflowRunId: undefined
      },
      {
        name: 'GitHub Actions #80',
        status: 'completed',
        conclusion: 'action_required',
        url: 'https://github.com/acme/widgets/commits/sha-1/checks#check-suite-80',
        checkRunId: undefined,
        workflowRunId: undefined
      }
    ])
  })
})
