import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlabApiResponse from './glab-api-response'

const { glabApiWithHeadersMock } = vi.hoisted(() => ({ glabApiWithHeadersMock: vi.fn() }))

vi.mock('./gl-utils', async () => ({
  ...(await vi.importActual<typeof GlabApiResponse>('./glab-api-response')),
  glabApiWithHeaders: glabApiWithHeadersMock,
  acquire: vi.fn(),
  release: vi.fn(),
  // Serves single-request fetches from the same pipeline, so a reverted fix fails on row counts.
  glabExecFileAsync: async (args: string[]) => ({
    stdout: (await glabApiWithHeadersMock(args.slice(1))).body
  }),
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: vi.fn(() => ({}))
}))

import { GitLabIncompletePaginationError } from './gitlab-paginated-list'
import { fetchPipelineJobs } from './pipeline-job-graph'
import { retryJob } from './pipeline-job-mutations'

/** Serves `/jobs` and `/bridges` 100 per page with GitLab's x-next-page header. */
function servePipeline(
  jobCount: number,
  bridgeCount: number,
  headers: 'gitlab' | 'stripped' | 'skipping' = 'gitlab'
): void {
  glabApiWithHeadersMock.mockImplementation(async (args: string[]) => {
    const match = /pipelines\/7\/(jobs|bridges)\?per_page=100(?:&page=(\d+))?$/.exec(
      args.at(-1) ?? ''
    )
    if (!match) {
      throw new Error(`unexpected endpoint ${args.at(-1)}`)
    }
    const page = Number(match[2] ?? 1)
    const total = match[1] === 'jobs' ? jobCount : bridgeCount
    const start = (page - 1) * 100
    const items = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) =>
      match[1] === 'jobs'
        ? { id: start + i + 1, name: `job-${start + i}` }
        : { name: `bridge-${start + i}` }
    )
    return {
      body: JSON.stringify(items),
      headers:
        headers === 'stripped'
          ? {}
          : {
              'x-next-page':
                start + 100 < total ? String(page + (headers === 'skipping' ? 3 : 1)) : ''
            }
    }
  })
}

describe('fetchPipelineJobs', () => {
  beforeEach(() => {
    glabApiWithHeadersMock.mockReset()
  })

  it('preserves optional failure policy through job, bridge and retry responses', async () => {
    glabApiWithHeadersMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1) ?? ''
      const raw = { id: 19, name: 'test', status: 'failed', allow_failure: true }
      return {
        body: JSON.stringify(
          endpoint.endsWith('/retry')
            ? raw
            : endpoint.includes('/bridges?')
              ? [{ ...raw, name: 'trigger' }]
              : [raw]
        ),
        headers: { 'x-next-page': '' }
      }
    })
    const project = { host: 'gitlab.com', path: 'g/p' }
    await expect(fetchPipelineJobs('/repo', project, 7)).resolves.toMatchObject([
      { id: 19, status: 'failed', allowFailure: true },
      { id: 0, name: 'trigger', status: 'failed', allowFailure: true }
    ])
    await expect(retryJob('/repo', 19, undefined, null, project)).resolves.toMatchObject({
      ok: true,
      job: { id: 19, allowFailure: true }
    })
  })

  it.each([
    // One request per started 100-item page on each endpoint.
    { jobs: 130, bridges: 101, requests: 4 },
    { jobs: 1300, bridges: 1010, requests: 24 },
    { jobs: 5001, bridges: 0, requests: 52 }
  ])(
    'collects $jobs jobs and $bridges bridges in $requests requests',
    async ({ jobs, bridges, requests }) => {
      servePipeline(jobs, bridges)

      const rows = await fetchPipelineJobs('/repo', { host: 'gitlab.com', path: 'g/p' }, 7)

      expect(rows.filter((row) => row.name.startsWith('job-'))).toHaveLength(jobs)
      expect(rows.filter((row) => row.name.startsWith('bridge-'))).toHaveLength(bridges)
      expect(glabApiWithHeadersMock).toHaveBeenCalledTimes(requests)
    }
  )

  it('does not skip pages when the next-page header jumps ahead', async () => {
    servePipeline(250, 0, 'skipping')

    const rows = await fetchPipelineJobs('/repo', { host: 'gitlab.com', path: 'g/p' }, 7)

    expect(rows.filter((row) => row.name.startsWith('job-'))).toHaveLength(250)
  })

  it('fails rather than return a prefix when guessed pages run out', async () => {
    // Without headers the walker guesses up to 50 pages past page 1, so 5,101 jobs never finish.
    servePipeline(5101, 0, 'stripped')

    await expect(
      fetchPipelineJobs('/repo', { host: 'gitlab.com', path: 'g/p' }, 7)
    ).rejects.toBeInstanceOf(GitLabIncompletePaginationError)
  })
})
