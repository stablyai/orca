import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  gitExecFileAsyncMock,
  extractExecErrorMock,
  getRateLimitMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  extractExecErrorMock: vi.fn((err: unknown) => {
    if (err && typeof err === 'object') {
      const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown }
      return {
        stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? err),
        stdout: typeof e.stdout === 'string' ? e.stdout : ''
      }
    }
    return { stderr: String(err), stdout: '' }
  }),
  getRateLimitMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  githubRepoContext: (repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  }),
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath }),
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  extractExecError: extractExecErrorMock,
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import { getPRChecks, rerunPRChecks, _resetOwnerRepoCache } from './client'

describe('getPRChecks', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    extractExecErrorMock.mockClear()
    getRateLimitMock.mockReset()
    getRateLimitMock.mockResolvedValue({ resources: {} })
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('queries check-runs by PR head SHA when GitHub remote metadata is available', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        check_runs: [
          {
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/acme/widgets/actions/runs/1',
            details_url: null
          }
        ]
      })
    })

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--cache', '60s', 'repos/acme/widgets/commits/head-oid/check-runs?per_page=100'],
      { cwd: '/repo-root' }
    )
    expect(checks).toEqual([
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/widgets/actions/runs/1',
        workflowRunId: 1
      }
    ])
  })

  it('falls back to gh pr checks when the head SHA has no check runs', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ check_runs: [] }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { name: 'verify', state: 'PENDING', link: 'https://example.com/verify' }
        ])
      })

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'checks', '42', '--json', 'name,state,link', '--repo', 'acme/widgets'],
      { cwd: '/repo-root' }
    )
    expect(checks).toEqual([
      {
        name: 'verify',
        status: 'queued',
        conclusion: 'pending',
        url: 'https://example.com/verify',
        workflowRunId: undefined
      }
    ])
  })

  it('treats gh pr checks "no checks reported" as an empty check list', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ check_runs: [] }) })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr checks 42'), {
          stderr: "no checks reported on the 'codex/keybindings-toml' branch\n",
          stdout: ''
        })
      )

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expect(checks).toEqual([])
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    consoleWarnSpy.mockRestore()
  })

  it('throws unexpected gh pr checks fallback failures so callers preserve cache', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ check_runs: [] }) })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr checks 42'), {
          stderr: 'GraphQL: Could not resolve to a PullRequest',
          stdout: ''
        })
      )

    await expect(getPRChecks('/repo-root', 42, 'head-oid')).rejects.toThrow(
      'Command failed: gh pr checks 42'
    )
    expect(consoleWarnSpy).toHaveBeenCalledWith('getPRChecks failed:', expect.any(Error))
    consoleWarnSpy.mockRestore()
  })

  it('falls back to gh pr checks when the cached head SHA no longer resolves', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('gh: No commit found for SHA: stale-head (HTTP 422)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: 'https://example.com/lint' }])
      })

    const checks = await getPRChecks('/repo-root', 42, 'stale-head')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'checks', '42', '--json', 'name,state,link', '--repo', 'acme/widgets'],
      { cwd: '/repo-root' }
    )
    expect(checks).toEqual([
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        url: 'https://example.com/lint',
        workflowRunId: undefined
      }
    ])
  })

  it('reruns GitHub Actions checks for a PR', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            name: 'lint',
            state: 'FAIL',
            link: 'https://github.com/acme/widgets/actions/runs/77/job/88'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await rerunPRChecks('/repo-root', 42, { failedOnly: true })

    expect(result).toEqual({ ok: true, count: 1 })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '-X', 'POST', 'repos/acme/widgets/actions/runs/77/rerun-failed-jobs'],
      { cwd: '/repo-root', env: { ...process.env, GH_PROMPT_DISABLED: '1' } }
    )
  })

  it('uses explicit PR repo for check-runs and gh pr checks fallback', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('gh: No commit found for SHA: stale-head (HTTP 422)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: 'https://example.com/lint' }])
      })

    await getPRChecks('/repo-root', 42, 'stale-head', { owner: 'acme', repo: 'widgets' })

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', '--cache', '60s', 'repos/acme/widgets/commits/stale-head/check-runs?per_page=100'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'checks', '42', '--json', 'name,state,link', '--repo', 'acme/widgets'],
      { cwd: '/repo-root' }
    )
  })

  it('throws when both check-runs and gh pr checks fail', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('gh: No commit found for SHA: stale-head (HTTP 422)'))
      .mockRejectedValueOnce(new Error('rate limited'))

    await expect(getPRChecks('/repo-root', 42, 'stale-head')).rejects.toThrow('rate limited')
  })
})
