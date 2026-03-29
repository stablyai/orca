import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn()
}))

vi.mock('util', async () => {
  const actual = await vi.importActual('util')
  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock)
  }
})

import { getPRForBranch, _resetOwnerRepoCache } from './client'

describe('getPRForBranch', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    _resetOwnerRepoCache()
  })

  it('queries GitHub by head branch when the remote is on github.com', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Fix PR discovery',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'refs/heads/feature/test')

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, 'git', ['remote', 'get-url', 'origin'], {
      cwd: '/repo-root',
      encoding: 'utf-8'
    })
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      [
        'pr',
        'list',
        '--repo',
        'acme/widgets',
        '--head',
        'feature/test',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable'
      ],
      { cwd: '/repo-root', encoding: 'utf-8' }
    )
    expect(pr?.number).toBe(42)
    expect(pr?.state).toBe('open')
    expect(pr?.mergeable).toBe('MERGEABLE')
  })

  it('falls back to gh pr view when the remote cannot be resolved to GitHub', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error('no origin')).mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Fallback lookup',
        state: 'OPEN',
        url: 'https://example.com/pr/7',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: true,
        mergeable: 'CONFLICTING'
      })
    })

    const pr = await getPRForBranch('/non-github-repo', 'feature/test')

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      [
        'pr',
        'view',
        'feature/test',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable'
      ],
      { cwd: '/non-github-repo', encoding: 'utf-8' }
    )
    expect(pr?.number).toBe(7)
    expect(pr?.state).toBe('draft')
    expect(pr?.mergeable).toBe('CONFLICTING')
  })

  it('returns null for empty branch (e.g. during rebase with detached HEAD)', async () => {
    const pr = await getPRForBranch('/repo-root', '')
    expect(pr).toBeNull()
    // Should not call gh at all
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null for refs/heads/ only branch (detached after strip)', async () => {
    const pr = await getPRForBranch('/repo-root', 'refs/heads/')
    expect(pr).toBeNull()
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null when pr list returns an empty array', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const pr = await getPRForBranch('/repo-root', 'no-pr-branch')

    expect(pr).toBeNull()
  })
})
