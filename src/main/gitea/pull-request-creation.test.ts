import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./repository-ref', () => ({
  getGiteaRepoRef: async () => ({
    owner: 'team',
    repo: 'repo',
    apiBaseUrl: 'https://gitea.example/api/v1'
  })
}))

import { createGiteaPullRequest } from './pull-request-creation'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const input = { provider: 'gitea', base: 'main', head: 'feature', title: 'A change' } as const

function stubFetch(createResponse: () => Response): void {
  vi.stubEnv('ORCA_GITEA_TOKEN', 'test-token')
  vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) =>
    init?.method === 'POST'
      ? createResponse()
      : Response.json([
          {
            number: 17,
            title: 'A change',
            state: 'open',
            html_url: 'https://gitea.example/team/repo/pulls/17',
            head: { ref: 'feature' }
          }
        ])
  )
}

it('reports the existing review when a successful create response is unreadable', async () => {
  stubFetch(
    () =>
      new Response('{"number":', {
        status: 201,
        headers: { 'content-type': 'application/json;charset=utf-8' }
      })
  )

  expect(await createGiteaPullRequest('/repo', input, 'local')).toMatchObject({
    ok: false,
    code: 'already_exists',
    existingReview: { number: 17, url: 'https://gitea.example/team/repo/pulls/17' }
  })
})

it('does not suggest creation completed when a success response is a non-JSON page', async () => {
  stubFetch(
    () =>
      new Response('<html>Sign in</html>', {
        status: 203,
        headers: { 'content-type': 'text/html' }
      })
  )

  expect(await createGiteaPullRequest('/repo', input, 'local')).toMatchObject({
    ok: false,
    code: 'unknown'
  })
})
