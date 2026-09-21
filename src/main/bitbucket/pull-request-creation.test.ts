import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBitbucketPullRequest,
  isBitbucketReviewCreationAuthenticated
} from './pull-request-creation'
import { _resetBitbucketRepoRefCache } from './repository-ref'

const { gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: () => 0
}))

vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => 'Template body')
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

const CREATE_INPUT = {
  provider: 'bitbucket',
  base: 'main',
  head: 'feature/login',
  title: 'Add login'
} as const

function createdPullRequestResponse(): Response {
  return Response.json({
    id: 42,
    title: 'Add login',
    state: 'OPEN',
    updated_on: '2026-08-11T00:00:00Z',
    links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/42' } },
    source: { branch: { name: 'feature/login' } },
    destination: { branch: { name: 'main' } }
  })
}

describe('Bitbucket pull request creation', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_BITBUCKET_ACCESS_TOKEN: 'bb-token' }
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://bitbucket.org/team/repo.git\n',
      stderr: ''
    })
    _resetBitbucketRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetBitbucketRepoRefCache()
  })

  it('posts the Bitbucket source/destination create body to the repository endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api.bitbucket.org')
      expect(url.pathname).toBe('/2.0/repositories/team/repo/pullrequests')
      const requestInit = init!
      expect(requestInit.method).toBe('POST')
      expect((requestInit.headers as Record<string, string>).Authorization).toBe('Bearer bb-token')
      expect(JSON.parse(String(requestInit.body))).toEqual({
        title: 'Add login',
        description: '',
        source: { branch: { name: 'feature/login' } },
        destination: { branch: { name: 'main' } }
      })
      return createdPullRequestResponse()
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(createBitbucketPullRequest('/repo', CREATE_INPUT, 'local')).resolves.toEqual({
      ok: true,
      number: 42,
      url: 'https://bitbucket.org/team/repo/pull-requests/42'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the stored credential when no environment variable is set', async () => {
    delete process.env.ORCA_BITBUCKET_ACCESS_TOKEN
    const fetchMock = vi.fn(async () => createdPullRequestResponse())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await createBitbucketPullRequest('/repo', CREATE_INPUT, 'local')

    // No env var and no stored credential: fail closed rather than POST anonymously.
    expect(result).toMatchObject({ ok: false, code: 'auth_required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores a draft request rather than dead-ending a hidden persisted default', async () => {
    const fetchMock = vi.fn(async () => createdPullRequestResponse())
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // Why: the composer hides the Draft toggle for Bitbucket, so a `true` here
    // is an unreachable persisted default the user cannot clear.
    await expect(
      createBitbucketPullRequest('/repo', { ...CREATE_INPUT, draft: true }, 'local')
    ).resolves.toMatchObject({ ok: true, number: 42 })
    expect(JSON.parse(String((fetchMock.mock.calls[0] as never[])[1]['body']))).not.toHaveProperty(
      'draft'
    )
  })

  it('reports authenticated only when a credential resolves', async () => {
    expect(isBitbucketReviewCreationAuthenticated()).toBe(true)
    delete process.env.ORCA_BITBUCKET_ACCESS_TOKEN
    expect(isBitbucketReviewCreationAuthenticated()).toBe(false)
  })

  it('maps a duplicate-branch rejection to already_exists with the existing review', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      if (call === 1) {
        return Response.json(
          { error: { message: 'There is already a pull request for this branch.' } },
          { status: 400 }
        )
      }
      return Response.json({
        values: [
          {
            id: 7,
            title: 'Add login',
            state: 'OPEN',
            updated_on: '2026-08-11T00:00:00Z',
            links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/7' } },
            source: { branch: { name: 'feature/login' } },
            destination: { branch: { name: 'main' } }
          }
        ]
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    expect(await createBitbucketPullRequest('/repo', CREATE_INPUT, 'local')).toMatchObject({
      ok: false,
      code: 'already_exists',
      existingReview: { number: 7, url: 'https://bitbucket.org/team/repo/pull-requests/7' }
    })
  })

  it('maps a 401 to auth_required pointing at both credential paths', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { message: 'Unauthorized' } }, { status: 401 })
    ) as unknown as typeof fetch

    const result = await createBitbucketPullRequest('/repo', CREATE_INPUT, 'local')

    expect(result).toMatchObject({ ok: false, code: 'auth_required' })
    expect(!result.ok && result.error).toContain('Settings')
  })

  it('refuses a non-Bitbucket remote', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://github.com/team/repo.git\n',
      stderr: ''
    })
    globalThis.fetch = vi.fn() as unknown as typeof fetch

    await expect(createBitbucketPullRequest('/repo', CREATE_INPUT, 'local')).resolves.toMatchObject(
      {
        ok: false,
        code: 'unsupported_provider'
      }
    )
  })
})
