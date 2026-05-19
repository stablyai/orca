import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getBitbucketAuthStatus, getBitbucketPullRequestForBranch } from './client'
import { _resetBitbucketRepoRefCache } from './repository-ref'

const OLD_ENV = process.env

function bitbucketPr(id = 7) {
  return {
    id,
    title: 'Add Bitbucket',
    state: 'OPEN',
    updated_on: '2026-05-10T00:00:00.000Z',
    links: { html: { href: `https://bitbucket.org/team/repo/pull-requests/${id}` } },
    source: {
      branch: { name: 'feature/bitbucket' },
      commit: { hash: 'abc123' },
      repository: { full_name: 'team/repo' }
    },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'team/repo' }
    }
  }
}

describe('Bitbucket client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_BITBUCKET_API_BASE_URL = 'https://api.test.local/2.0'
    process.env.ORCA_BITBUCKET_EMAIL = 'user@example.com'
    process.env.ORCA_BITBUCKET_API_TOKEN = 'token'
    delete process.env.ORCA_BITBUCKET_ACCESS_TOKEN
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/repo.git\n',
      stderr: ''
    })
    _resetBitbucketRepoRefCache()
    vi.unstubAllGlobals()
  })

  it('fetches a branch pull request and commit build status', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [{ state: 'SUCCESSFUL' }] })
      }
      return Response.json({ values: [bitbucketPr()] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/bitbucket')
    ).resolves.toEqual({
      number: 7,
      title: 'Add Bitbucket',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/7',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })

    const firstCall = fetchMock.mock.calls[0]
    const listUrl = String(firstCall?.[0])
    const listInit = firstCall?.[1]
    if (!listInit) {
      throw new Error('expected request init')
    }
    const parsed = new URL(listUrl)
    expect(parsed.pathname).toBe('/2.0/repositories/team/repo/pullrequests')
    expect(parsed.searchParams.get('q')).toBe(
      'source.branch.name = "feature/bitbucket" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")'
    )
    expect(parsed.searchParams.getAll('state')).toEqual([
      'OPEN',
      'MERGED',
      'DECLINED',
      'SUPERSEDED'
    ])
    expect((listInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user@example.com:token').toString('base64')}`
    )
  })

  it('falls back to a linked PR number when branch lookup misses', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      if (url.endsWith('/pullrequests/42')) {
        return Response.json(bitbucketPr(42))
      }
      return Response.json({ values: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketPullRequestForBranch('/repo', 'different', 42)).resolves.toMatchObject(
      {
        number: 42,
        status: 'neutral'
      }
    )
  })

  it('reports env-token auth status through the Bitbucket /user endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ username: 'bitbucket-user' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'bitbucket-user'
    })
  })
})
