import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  glabExecFileAsyncMock,
  getGlabKnownHostsMock,
  resolveIssueSourceMock,
  glabRepoExecOptionsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  glabRepoExecOptionsMock: vi.fn(
    (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions: { wslDistro?: string } = {}
    ) => (connectionId ? {} : { cwd: repoPath, ...localGitOptions })
  ),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('../requests/glab-request-admission', () => ({
  glabApiWithHeaders: async (args: string[], options: unknown) => ({
    body: (await glabExecFileAsyncMock(['api', ...args], options)).stdout,
    headers: {}
  }),
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../projects/gitlab-known-host-probe', () => ({
  getGlabKnownHosts: getGlabKnownHostsMock
}))

vi.mock('../issues/gitlab-issue-source-resolution', () => ({
  resolveIssueSource: resolveIssueSourceMock
}))

vi.mock('../../git/command-runner/glab-exec-file', () => ({
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../projects/gitlab-project-ref-resolution', () => ({
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: glabRepoExecOptionsMock
}))
import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    resolveIssueSourceMock.mockReset()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  // Every child fetch launches glab; bound the pool during Checks polling.

  // Parent pipeline 99 has 150 jobs and 100 bridges, one to child pipeline 1000, which has 150 jobs.
  function servePipelineGraph(failing: { endpoint: string; page: number; message: string }): void {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1) as string
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            iid: 12,
            title: 'Graph',
            state: 'opened',
            head_pipeline: { id: 99 }
          })
        }
      }
      const listMatch =
        /^(projects\/g%2Fp\/pipelines\/\d+\/(?:jobs|bridges))\?per_page=100&page=(\d+)$/.exec(
          endpoint
        )
      if (!listMatch) {
        return { stdout: endpoint.endsWith('/approvals') ? '{}' : '[]' }
      }
      const [, list, pageText] = listMatch
      const page = Number(pageText)
      if (list === failing.endpoint && page === failing.page) {
        throw new Error(failing.message)
      }
      if (list.endsWith('/bridges')) {
        // A full first page makes the walker request page 2.
        const bridges = list.includes('/99/')
          ? [
              { name: 'child', downstream_pipeline: { id: 1000, status: 'success' } },
              ...Array.from({ length: 99 }, (_, i) => ({ name: `trigger-${i}` }))
            ]
          : []
        return { stdout: JSON.stringify(page === 1 ? bridges : []) }
      }
      const pipelineId = Number(/pipelines\/(\d+)/.exec(list)?.[1])
      const count = page === 1 ? 100 : page === 2 ? 50 : 0
      return {
        stdout: JSON.stringify(
          Array.from({ length: count }, (_, i) => ({
            id: pipelineId * 1000 + (page - 1) * 100 + i + 1,
            name: `job-${pipelineId}-${(page - 1) * 100 + i}`
          }))
        )
      }
    })
  }

  it.each([
    { endpoint: 'projects/g%2Fp/pipelines/99/jobs', includeReviewDetails: true },
    { endpoint: 'projects/g%2Fp/pipelines/99/jobs', includeReviewDetails: false },
    { endpoint: 'projects/g%2Fp/pipelines/1000/jobs', includeReviewDetails: false },
    { endpoint: 'projects/g%2Fp/pipelines/99/bridges', includeReviewDetails: false }
  ])(
    'fails the read when $endpoint page 2 fails (includeReviewDetails=$includeReviewDetails)',
    async ({ endpoint, includeReviewDetails }) => {
      servePipelineGraph({ endpoint, page: 2, message: '503 upstream unavailable' })

      const details = await getWorkItemDetails(
        '/repo',
        12,
        'mr',
        undefined,
        undefined,
        undefined,
        undefined,
        { includeReviewDetails }
      )

      expect(details).toBeNull()
    }
  )

  it('keeps the graph when a child project forbids its first page', async () => {
    servePipelineGraph({
      endpoint: 'projects/g%2Fp/pipelines/1000/jobs',
      page: 1,
      message: '403 Forbidden'
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')

    expect(details?.pipelineJobs?.filter((job) => job.name.startsWith('job-99-'))).toHaveLength(150)
    expect(details?.pipelineJobs?.some((job) => job.name === 'child')).toBe(true)
  })
})
