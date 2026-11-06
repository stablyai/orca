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

vi.mock('./gl-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  getGlabKnownHosts: getGlabKnownHostsMock,
  resolveIssueSource: resolveIssueSourceMock,
  glabExecFileAsync: glabExecFileAsyncMock,
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
  it('bounds concurrent child-pipeline fetches', async () => {
    const BRIDGE_COUNT = 25
    let inFlightJobPages = 0
    let peakJobPages = 0

    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1) as string
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            iid: 12,
            title: 'Fan out',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'f',
            target_branch: 'main',
            sha: 'head-sha',
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return {
          stdout: JSON.stringify(
            Array.from({ length: BRIDGE_COUNT }, (_, i) => ({
              id: 500 + i,
              name: `trigger-${i}`,
              stage: 'trigger',
              status: 'success',
              downstream_pipeline: {
                id: 1000 + i,
                status: 'running',
                web_url: `https://gitlab.com/g/p/-/pipelines/${1000 + i}`
              }
            }))
          )
        }
      }
      if (/pipelines\/\d+\/jobs/.test(endpoint)) {
        inFlightJobPages += 1
        peakJobPages = Math.max(peakJobPages, inFlightJobPages)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlightJobPages -= 1
        return { stdout: '[]' }
      }
      if (endpoint.endsWith('/approvals')) {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint.endsWith('/approval_state')) {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      return { stdout: '[]' }
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')
    // The parent page can overlap the capped child pool.
    expect(peakJobPages).toBeLessThanOrEqual(5)
    expect(details?.pipelineJobs).toHaveLength(BRIDGE_COUNT)
  })
})
