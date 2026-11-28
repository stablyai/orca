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

it('allows case-distinct branch names while still rejecting the same normalized branch', async () => {
  vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://gitea.example/api/v1')
  vi.stubEnv('ORCA_GITEA_TOKEN', 'test-token')
  vi.stubGlobal('fetch', async () =>
    Response.json({
      number: 23,
      title: 'A change',
      state: 'open',
      html_url: 'https://gitea.example/team/repo/pulls/23'
    })
  )

  expect(
    await createGiteaPullRequest(
      '/repo',
      { provider: 'gitea', base: 'feature', head: 'Feature', title: 'A change' },
      'local'
    )
  ).toEqual({ ok: true, number: 23, url: 'https://gitea.example/team/repo/pulls/23' })
  expect(
    await createGiteaPullRequest(
      '/repo',
      { provider: 'gitea', base: 'feature', head: 'refs/heads/feature', title: 'A change' },
      'local'
    )
  ).toMatchObject({ ok: false, code: 'validation', reason: 'same_base_branch' })
})
