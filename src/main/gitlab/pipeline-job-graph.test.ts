import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlabApiResponse from './glab-api-response'

const { glabApiWithHeadersMock } = vi.hoisted(() => ({ glabApiWithHeadersMock: vi.fn() }))

vi.mock('./gl-utils', async () => ({
  ...(await vi.importActual<typeof GlabApiResponse>('./glab-api-response')),
  glabApiWithHeaders: glabApiWithHeadersMock,
  // Serves single-request fetches from the same pipeline, so a reverted fix fails on row counts.
  glabExecFileAsync: async (args: string[]) => ({
    stdout: (await glabApiWithHeadersMock(args.slice(1))).body
  }),
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: vi.fn(() => ({}))
}))

import { fetchPipelineJobs } from './pipeline-job-graph'

/** Serves `/jobs` and `/bridges` 100 per page with GitLab's x-next-page header. */
function servePipeline(jobCount: number, bridgeCount: number): void {
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
      headers: { 'x-next-page': start + 100 < total ? String(page + 1) : '' }
    }
  })
}

describe('fetchPipelineJobs', () => {
  beforeEach(() => {
    glabApiWithHeadersMock.mockReset()
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
})
