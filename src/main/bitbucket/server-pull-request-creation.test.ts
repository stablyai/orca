import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, baseUrlMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  baseUrlMock: vi.fn<() => string | null>()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./server-auth-config', async (importActual) => ({
  ...(await importActual<typeof ServerAuthConfig>()),
  getBitbucketServerBaseUrl: baseUrlMock
}))

vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => 'Template body')
}))

import type * as ServerAuthConfig from './server-auth-config'
import {
  createBitbucketServerPullRequest,
  isBitbucketServerReviewCreationAuthenticated
} from './server-pull-request-creation'
import { _resetBitbucketServerRepoRefCache } from './server-repository-ref'

const OLD_ENV = process.env
const BASE = 'https://bitbucket.example.com'
const REPO_API = `${BASE}/rest/api/1.0/projects/prj/repos/repo`
const DEFAULT_REVIEWERS =
  `${BASE}/rest/default-reviewers/1.0/projects/prj/repos/repo/reviewers` +
  '?sourceRepoId=7&targetRepoId=7&sourceRefId=refs%2Fheads%2Ffeat&targetRefId=refs%2Fheads%2Fmain'

const CREATE_INPUT = {
  provider: 'bitbucket',
  base: 'main',
  head: 'feat',
  title: 'Add server support'
} as const

function createdPr(id = 42) {
  return {
    id,
    title: 'Add server support',
    state: 'OPEN',
    updatedDate: 1792460776769,
    fromRef: { id: 'refs/heads/feat', displayId: 'feat', latestCommit: 'abc123' },
    toRef: { id: 'refs/heads/main', displayId: 'main', latestCommit: 'def456' },
    reviewers: [],
    links: { self: [{ href: `${BASE}/projects/PRJ/repos/repo/pull-requests/${id}` }] }
  }
}

function repoResponse(): Response {
  return new Response(JSON.stringify({ id: 7, slug: 'repo', project: { key: 'PRJ' } }), {
    headers: { 'Content-Type': 'application/json', 'X-AUSERNAME': 'alice' }
  })
}

function serverError(status: number, message: string): Response {
  return Response.json({ errors: [{ context: null, message, exceptionName: null }] }, { status })
}

type Route = (init?: RequestInit) => Response
function routeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!key) {
      throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
    }
    return routes[key](init)
  })
}

describe('Bitbucket Server pull request creation', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_BITBUCKET_SERVER_BASE_URL = BASE
    process.env.ORCA_BITBUCKET_SERVER_TOKEN = 't0k'
    baseUrlMock.mockReturnValue(BASE)
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${BASE}/scm/prj/repo.git\n`, stderr: '' })
    _resetBitbucketServerRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  it('creates the PR with default reviewers except the current user', async () => {
    let postBody: unknown = null
    const fetchMock = routeFetch({
      [DEFAULT_REVIEWERS]: () => Response.json([{ name: 'alice' }, { name: 'bob' }]),
      [`${REPO_API}/pull-requests`]: (init) => {
        expect(init?.method).toBe('POST')
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer t0k' })
        postBody = JSON.parse(String(init?.body))
        return Response.json(createdPr(), { status: 201 })
      },
      [REPO_API]: () => repoResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')).resolves.toEqual(
      {
        ok: true,
        number: 42,
        url: `${BASE}/projects/PRJ/repos/repo/pull-requests/42`
      }
    )
    expect(postBody).toEqual({
      title: 'Add server support',
      description: '',
      fromRef: { id: 'refs/heads/feat', repository: { slug: 'repo', project: { key: 'PRJ' } } },
      toRef: { id: 'refs/heads/main', repository: { slug: 'repo', project: { key: 'PRJ' } } },
      reviewers: [{ user: { name: 'bob' } }]
    })
  })

  it('still creates the PR when the default-reviewer lookup fails', async () => {
    let postBody: { reviewers?: unknown } = {}
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => new Response('', { status: 500 }),
        [`${REPO_API}/pull-requests`]: (init) => {
          postBody = JSON.parse(String(init?.body))
          return Response.json(createdPr(), { status: 201 })
        },
        [REPO_API]: () => repoResponse()
      })
    )

    await expect(
      createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')
    ).resolves.toMatchObject({ ok: true, number: 42 })
    expect(postBody.reviewers).toEqual([])
  })

  it('reports an existing open PR on 409', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => Response.json([]),
        [`${REPO_API}/pull-requests?`]: () => Response.json({ size: 1, values: [createdPr(41)] }),
        [`${REPO_API}/pull-requests/41/merge`]: () => Response.json({ outcome: 'CLEAN' }),
        [`${REPO_API}/pull-requests`]: () =>
          serverError(
            409,
            'Only one pull request may be open for a given source and target branch'
          ),
        [`${BASE}/rest/build-status`]: () =>
          Response.json({ successful: 0, inProgress: 0, failed: 0 }),
        [REPO_API]: () => repoResponse()
      })
    )

    await expect(createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')).resolves.toEqual(
      {
        ok: false,
        code: 'already_exists',
        error: 'A pull request already exists for this branch.',
        existingReview: { number: 41, url: `${BASE}/projects/PRJ/repos/repo/pull-requests/41` }
      }
    )
  })

  it('shows the server reason on 409 without an existing PR', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => Response.json([]),
        [`${REPO_API}/pull-requests?`]: () => Response.json({ size: 0, values: [] }),
        [`${REPO_API}/pull-requests`]: () =>
          serverError(409, 'refs/heads/main is already up-to-date with refs/heads/feat'),
        [REPO_API]: () => repoResponse()
      })
    )

    await expect(createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')).resolves.toEqual(
      {
        ok: false,
        code: 'validation',
        error:
          'Create PR failed: Bitbucket Server rejected the pull request: refs/heads/main is already up-to-date with refs/heads/feat'
      }
    )
  })

  it('does not report a declined PR as already existing on 409', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => Response.json([]),
        [`${REPO_API}/pull-requests?`]: () =>
          Response.json({ size: 1, values: [{ ...createdPr(41), state: 'DECLINED' }] }),
        [`${REPO_API}/pull-requests`]: () =>
          serverError(409, 'refs/heads/main is already up-to-date with refs/heads/feat'),
        [`${BASE}/rest/build-status`]: () =>
          Response.json({ successful: 0, inProgress: 0, failed: 0 }),
        [REPO_API]: () => repoResponse()
      })
    )

    await expect(
      createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')
    ).resolves.toMatchObject({ ok: false, code: 'validation' })
  })

  it('reports a timed-out create as possibly completed', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => Response.json([]),
        [`${REPO_API}/pull-requests?`]: () => Response.json({ size: 0, values: [] }),
        [`${REPO_API}/pull-requests`]: () => {
          throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
        },
        [REPO_API]: () => repoResponse()
      })
    )

    await expect(
      createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')
    ).resolves.toMatchObject({ ok: false, code: 'unknown_completion' })
  })

  it('logs a failed create', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => Response.json([]),
        [`${REPO_API}/pull-requests`]: () => serverError(401, 'Authentication failed'),
        [REPO_API]: () => repoResponse()
      })
    )

    await createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')

    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it.each([
    [401, 'auth_required'],
    [403, 'auth_required'],
    [404, 'validation'],
    [400, 'validation']
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [DEFAULT_REVIEWERS]: () => Response.json([]),
        [`${REPO_API}/pull-requests`]: () => serverError(status, 'nope'),
        [REPO_API]: () => repoResponse()
      })
    )

    await expect(
      createBitbucketServerPullRequest('/repo', CREATE_INPUT, 'local')
    ).resolves.toMatchObject({ ok: false, code })
  })

  it.each([[{ ...CREATE_INPUT, head: 'main' }], [{ ...CREATE_INPUT, title: '  ' }]])(
    'rejects invalid input before calling the server: %o',
    async (input) => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        createBitbucketServerPullRequest('/repo', input, 'local')
      ).resolves.toMatchObject({
        ok: false,
        code: 'validation'
      })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('needs a server credential to offer creation', () => {
    expect(isBitbucketServerReviewCreationAuthenticated()).toBe(true)
    delete process.env.ORCA_BITBUCKET_SERVER_TOKEN
    delete process.env.ORCA_BITBUCKET_SERVER_BASE_URL
    expect(isBitbucketServerReviewCreationAuthenticated()).toBe(false)
  })
})
