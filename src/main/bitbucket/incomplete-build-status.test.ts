import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./repository-ref', () => ({
  getBitbucketRepoRef: async () => ({ workspace: 'team', repoSlug: 'repo' })
}))

import { getBitbucketPullRequest } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('does not report all checks passed from an incomplete status page', async () => {
  vi.stubEnv('ORCA_BITBUCKET_ACCESS_TOKEN', 'test-token')
  let complete = false
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    return Response.json(
      url.pathname.endsWith('/statuses')
        ? {
            values: [{ state: 'SUCCESSFUL' }],
            ...(complete ? {} : { next: 'https://api.bitbucket.org/2.0/statuses?page=2' })
          }
        : {
            id: 1,
            title: 'A change',
            state: 'OPEN',
            links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/1' } },
            source: { commit: { hash: 'head' } }
          }
    )
  })

  const partial = await getBitbucketPullRequest('/repo', 1)
  expect(partial?.status).toBe('neutral')
  expect(partial?.checksSummary).toBeUndefined()
  complete = true
  expect(await getBitbucketPullRequest('/repo', 1)).toMatchObject({
    status: 'success',
    checksSummary: { total: 1, passed: 1 }
  })
})
