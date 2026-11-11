import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  glabExecFileAsyncMock,
  glabApiWithHeadersMock,
  getGlabKnownHostsMock,
  getProjectRefMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  getProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('../../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../requests/glab-request-admission', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabApiWithHeaders: glabApiWithHeadersMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../projects/gitlab-known-host-probe', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlabKnownHosts: getGlabKnownHostsMock
}))

vi.mock('../projects/gitlab-project-ref-resolution', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectRef: getProjectRefMock
}))

vi.mock('../issues/gitlab-issue-source-resolution', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveIssueSource: resolveIssueSourceMock
}))

import { listWorkItems } from './work-item-queries'

describe('gitlab client — combined listWorkItems', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    glabApiWithHeadersMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    getProjectRefMock.mockReset()
    resolveIssueSourceMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    }))
  })

  it('still returns issues when MRs error out', async () => {
    glabApiWithHeadersMock.mockRejectedValueOnce(new Error('HTTP 500'))
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { id: 200, iid: 9, title: 'live issue', state: 'opened', updated_at: '2026-05-08' }
      ])
    })

    const result = await listWorkItems('/repo', 'opened', 1, 20)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].title).toBe('live issue')
    expect(result.error).toBeDefined()
  })

  it('reports the body instead of ".map is not a function" when the issues fetch returns a non-array', async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ data: [], total: 0 })
    })

    const result = await listWorkItems('/repo', 'opened', 1, 20)
    expect(result.items).toEqual([])
    expect(result.error?.message).toContain('{"data":[],"total":0}')
    expect(result.error?.message).not.toContain('is not a function')
  })
})
