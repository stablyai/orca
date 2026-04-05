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

import { getPRForBranch, getPRChecks, _resetOwnerRepoCache } from './client'

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
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
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
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
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
        mergeable: 'CONFLICTING',
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
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
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/non-github-repo', encoding: 'utf-8' }
    )
    expect(pr?.number).toBe(7)
    expect(pr?.state).toBe('draft')
    expect(pr?.mergeable).toBe('CONFLICTING')
  })

  it('derives a read-only conflict summary for conflicting PRs when the base ref exists locally', async () => {
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
            mergeable: 'CONFLICTING',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '3\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/a.ts\u0000src/b.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'latest-',
      commitsBehind: 3,
      files: ['src/a.ts', 'src/b.ts']
    })
  })

  it('keeps conflicted file paths when git merge-tree exits 1 with stdout', async () => {
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
            mergeable: 'CONFLICTING',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stdout: 'result-tree-oid\u0000src/conflict.ts\u0000'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('falls back to GitHub baseRefOid when fetching or resolving the base ref fails', async () => {
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
            mergeable: 'CONFLICTING',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('missing refs/remotes/origin/main'))
      .mockRejectedValueOnce(new Error('missing origin/main'))
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/fallback.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'base-oi',
      commitsBehind: 1,
      files: ['src/fallback.ts']
    })
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

describe('getPRChecks', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    _resetOwnerRepoCache()
  })

  it('queries check-runs by PR head SHA when GitHub remote metadata is available', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockResolvedValueOnce({
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

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', '--cache', '60s', 'repos/acme/widgets/commits/head-oid/check-runs?per_page=100'],
      { cwd: '/repo-root', encoding: 'utf-8' }
    )
    expect(checks).toEqual([
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/widgets/actions/runs/1'
      }
    ])
  })

  it('falls back to gh pr checks when the cached head SHA no longer resolves', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockRejectedValueOnce(new Error('gh: No commit found for SHA: stale-head (HTTP 422)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: 'https://example.com/lint' }])
      })

    const checks = await getPRChecks('/repo-root', 42, 'stale-head')

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      'gh',
      ['pr', 'checks', '42', '--json', 'name,state,link'],
      { cwd: '/repo-root', encoding: 'utf-8' }
    )
    expect(checks).toEqual([
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        url: 'https://example.com/lint'
      }
    ])
  })
})
