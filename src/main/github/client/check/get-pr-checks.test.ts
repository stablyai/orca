import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubApiRepositoryModule from '../../github-api-repository'

const { ghExecFileAsyncMock } = vi.hoisted(() => ({ ghExecFileAsyncMock: vi.fn() }))

vi.mock('../../gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  acquire: vi.fn(async () => undefined),
  release: vi.fn()
}))
vi.mock('../../github-repository-identity', () => ({
  withGitHubRepoExecution: (_r: string, _c: unknown, _l: unknown, run: () => unknown) => run(),
  githubRepoContext: (repoPath: string) => ({ repoPath }),
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath })
}))
vi.mock('../../github-read-execution-scope', () => ({ githubReadExecutionScope: () => 'local' }))
vi.mock('../../github-api-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubApiRepositoryModule>()),
  resolveGitHubRepoExecution: async () => ({
    ownerRepo: { owner: 'acme', repo: 'widgets' },
    ghOptions: { cwd: '/repo' }
  })
}))
vi.mock('../../rate-limit', () => ({ noteRepositoryRateLimitSpend: vi.fn() }))
vi.mock('../lookup/pr-lookup-rate-limit', () => ({ assertRateLimitBudget: vi.fn() }))

import { getPRChecks } from './get-pr-checks'

const HEAD = 'a'.repeat(40)

beforeEach(() => {
  ghExecFileAsyncMock.mockReset()
})

describe('getPRChecks run times', () => {
  it('reads the rollup without gh’s disk cache, which ignores the PR head', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: HEAD,
              commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] }
            }
          }
        }
      })
    })
    await getPRChecks('/repo', 1, HEAD)
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).not.toContain('--cache')
  })

  it('keeps REST check-run times through the fallback’s schema', async () => {
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [
            {
              id: 88,
              name: 'build',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/acme/widgets/runs/88',
              details_url: null,
              started_at: '2026-11-05T10:00:00Z',
              completed_at: '2026-11-05T10:03:12Z'
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total_count: 0, statuses: [] }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total_count: 0, check_suites: [] }) })
    const [check] = await getPRChecks('/repo', 2, HEAD)
    expect(check).toMatchObject({
      startedAt: '2026-11-05T10:00:00Z',
      completedAt: '2026-11-05T10:03:12Z'
    })
  })

  it('asks an older gh without run-time fields for the fields it knows', async () => {
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockRejectedValueOnce(new Error('REST details failed'))
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed'), { stderr: 'Unknown JSON field: "startedAt"' })
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: '' }])
      })
    const checks = await getPRChecks('/repo', 3, HEAD)
    expect(ghExecFileAsyncMock.mock.calls[3]?.[0]).toContain('name,state,link')
    expect(checks.map((check) => check.name)).toEqual(['lint'])
  })
})
