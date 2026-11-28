import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./repository-ref', () => ({
  getAzureDevOpsRepoRef: async () => ({
    host: 'dev.azure.com',
    project: 'project',
    repository: 'repo',
    apiBaseUrl: 'https://dev.azure.com/org/project',
    webBaseUrl: 'https://dev.azure.com/org/project/_git/repo'
  })
}))

import { getAzureDevOpsPullRequest } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('uses the latest commit status per context after a failed check succeeds on retry', async () => {
  vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/pullRequests/1/statuses')) {
      return Response.json({ value: [] })
    }
    if (url.pathname.endsWith('/commits/head/statuses')) {
      const latest = { state: 'succeeded', context: { name: 'tests', genre: 'ci' } }
      return Response.json({
        value:
          url.searchParams.get('latestOnly') === 'true'
            ? [latest]
            : [{ state: 'failed', context: latest.context }, latest]
      })
    }
    return Response.json(
      url.pathname.endsWith('/pullRequests/1')
        ? { pullRequestId: 1, title: 'A change', lastMergeSourceCommit: { commitId: 'head' } }
        : { id: 'repo' }
    )
  })

  expect(await getAzureDevOpsPullRequest('/repo', 1)).toMatchObject({
    status: 'success',
    checksSummary: { total: 1, passed: 1, failed: 0 }
  })
})
