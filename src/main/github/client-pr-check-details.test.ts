import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, getOwnerRepoMock, rateLimitGuardMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false }))
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  githubRepoContext: (repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  }),
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath }),
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: vi.fn(),
  extractExecError: vi.fn((err: unknown) => ({ stderr: String(err), stdout: '' })),
  acquire: vi.fn(),
  release: vi.fn(),
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn()
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: vi.fn()
}))

import { getPRCheckDetails, _resetOwnerRepoCache } from './client'

describe('getPRCheckDetails', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    _resetOwnerRepoCache()
  })

  it('fetches check-run output, annotations, and workflow jobs for inline details', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    const actionUrl = 'https://github.com/acme/widgets/actions/runs/77/job/88'
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          name: 'track-community-pr',
          status: 'completed',
          conclusion: 'success',
          html_url: actionUrl,
          details_url: actionUrl,
          started_at: '2026-05-18T19:00:00Z',
          completed_at: '2026-05-18T19:02:00Z',
          output: {
            title: 'Successful',
            summary: 'Tracked community PR',
            text: 'No issues found.'
          },
          check_suite: { workflow_run: { id: 77 } }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            path: '.github/workflows/community.yml',
            start_line: 12,
            end_line: 12,
            annotation_level: 'notice',
            title: 'Tracked',
            message: 'Community PR tracked.',
            raw_details: 'details'
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          jobs: [
            {
              id: 8801,
              name: 'track-community-pr',
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-05-18T19:00:00Z',
              completed_at: '2026-05-18T19:02:00Z',
              html_url: actionUrl,
              steps: [{ name: 'Run tracker', status: 'completed', conclusion: 'success' }]
            }
          ]
        })
      })

    const details = await getPRCheckDetails('/repo-root', {
      checkRunId: 88,
      checkName: 'track-community-pr'
    })

    expect(details).toMatchObject({
      name: 'track-community-pr',
      status: 'completed',
      conclusion: 'success',
      title: 'Successful',
      summary: 'Tracked community PR',
      text: 'No issues found.',
      annotations: [
        {
          path: '.github/workflows/community.yml',
          startLine: 12,
          endLine: 12,
          annotationLevel: 'notice',
          title: 'Tracked',
          message: 'Community PR tracked.',
          rawDetails: 'details'
        }
      ],
      jobs: [
        {
          id: 8801,
          name: 'track-community-pr',
          conclusion: 'success',
          logTail: null,
          steps: [{ name: 'Run tracker', status: 'completed', conclusion: 'success' }]
        }
      ]
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/check-runs/88'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/acme/widgets/check-runs/88/annotations?per_page=20'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', 'repos/acme/widgets/actions/runs/77/jobs?per_page=100'],
      { cwd: '/repo-root' }
    )
  })

  it('fetches sliced log tails for failed workflow jobs only', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    const actionUrl = 'https://github.com/acme/widgets/actions/runs/77/job/88'
    const logLines = Array.from({ length: 210 }, (_, index) => `line ${index} ${'x'.repeat(120)}`)
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          name: 'verify',
          status: 'completed',
          conclusion: 'failure',
          html_url: actionUrl,
          details_url: actionUrl,
          check_suite: { workflow_run: { id: 77 } }
        })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          jobs: [
            {
              id: 8801,
              name: 'verify',
              status: 'completed',
              conclusion: 'failure',
              completed_at: '2026-05-18T19:02:00Z',
              html_url: actionUrl,
              steps: [{ name: 'Run tests', status: 'completed', conclusion: 'failure' }]
            },
            {
              id: 8802,
              name: 'lint',
              status: 'completed',
              conclusion: 'success',
              completed_at: '2026-05-18T19:02:00Z',
              html_url: actionUrl,
              steps: [{ name: 'Run lint', status: 'completed', conclusion: 'success' }]
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stdout: logLines.join('\n') })

    const details = await getPRCheckDetails('/repo-root', { checkRunId: 88 })

    expect(details?.jobs[0]).toMatchObject({
      id: 8801,
      name: 'verify',
      conclusion: 'failure'
    })
    expect(details?.jobs[0].logTail).toContain('line 209')
    expect(details?.jobs[0].logTail).not.toContain('line 0')
    expect(Buffer.from(details?.jobs[0].logTail ?? '', 'utf8').byteLength).toBeLessThanOrEqual(
      16 * 1024
    )
    expect(details?.jobs[1]).toMatchObject({
      id: 8802,
      name: 'lint',
      conclusion: 'success',
      logTail: null
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      ['api', 'repos/acme/widgets/actions/jobs/8801/logs'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(4)
  })
})
