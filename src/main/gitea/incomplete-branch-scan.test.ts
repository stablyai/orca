import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./repository-ref', () => ({
  getGiteaRepoRef: async () => ({
    owner: 'team',
    repo: 'repo',
    apiBaseUrl: 'https://gitea.example/api/v1'
  })
}))

import { getGiteaPullRequestForBranchOrThrow } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('keeps a found review but cannot prove absence after a capped scan', async () => {
  vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://gitea.example/api/v1')
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/status')) {
      return Response.json({ state: 'success' })
    }
    const page = Number(url.searchParams.get('page') ?? 1)
    return Response.json(
      Array.from({ length: 50 }, (_, index) => ({
        number: (page - 1) * 50 + index + 1,
        title: 'Existing review',
        state: 'open',
        html_url: 'https://gitea.example/team/repo/pulls/1',
        head: { ref: index === 0 && page === 1 ? 'found' : 'unrelated', sha: 'head' }
      }))
    )
  })

  await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'missing')).rejects.toThrow(
    'Gitea pull request scan is incomplete'
  )
  await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'found')).resolves.toMatchObject({
    number: 1,
    state: 'open'
  })
})
