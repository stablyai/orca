import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./repository-ref', () => ({
  getBitbucketRepoRef: async () => ({ workspace: 'team', repoSlug: 'repo' })
}))

import { getBitbucketPullRequest } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function stubStatusPages(pages: string[][]): string[] {
  vi.stubEnv('ORCA_BITBUCKET_ACCESS_TOKEN', 'test-token')
  const statusUrls: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    if (!url.pathname.endsWith('/statuses')) {
      return Response.json({
        id: 1,
        title: 'A change',
        state: 'OPEN',
        links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/1' } },
        source: { commit: { hash: 'head' } }
      })
    }
    statusUrls.push(url.toString())
    const page = Number(url.searchParams.get('page') ?? '1')
    return Response.json({
      values: pages[page - 1].map((state) => ({ state })),
      ...(page < pages.length
        ? { next: `https://elsewhere.example/statuses?pagelen=100&page=${page + 1}` }
        : {})
    })
  })
  return statusUrls
}

it('reads every status page before reporting checks passed', async () => {
  const statusUrls = stubStatusPages([['SUCCESSFUL'], ['SUCCESSFUL']])
  expect(await getBitbucketPullRequest('/repo', 1)).toMatchObject({
    status: 'success',
    checksSummary: { total: 2, passed: 2 }
  })
  expect(statusUrls[1]).toBe(
    'https://api.bitbucket.org/2.0/repositories/team/repo/commit/head/statuses?pagelen=100&page=2'
  )
})

it('reports a failure that only appears on a later page', async () => {
  stubStatusPages([['SUCCESSFUL'], ['FAILED']])
  expect(await getBitbucketPullRequest('/repo', 1)).toMatchObject({
    status: 'failure',
    checksSummary: { total: 2, failed: 1 }
  })
})

it('does not report checks passed when pages remain past the cap', async () => {
  const statusUrls = stubStatusPages(Array.from({ length: 6 }, () => ['SUCCESSFUL']))
  const pr = await getBitbucketPullRequest('/repo', 1)
  expect(pr?.status).toBe('neutral')
  expect(pr?.checksSummary).toBeUndefined()
  expect(statusUrls).toHaveLength(5)
})
