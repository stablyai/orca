import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

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

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    glabApiWithHeaders: glabApiWithHeadersMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    getProjectRef: getProjectRefMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import { listWorkItems } from './client'

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

  it('merges MRs + issues and sorts by updatedAt desc', async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({
      body: JSON.stringify([
        {
          id: 100,
          iid: 1,
          title: 'older mr',
          state: 'opened',
          updated_at: '2026-05-05T00:00:00Z',
          source_project_id: 5,
          target_project_id: 5
        }
      ]),
      headers: { 'x-total': '1', 'x-total-pages': '1' }
    })
    // Why: listIssues calls glabExecFileAsync (not glabApiWithHeaders) —
    // it reads the issues list endpoint via the regular `glab api` path.
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          id: 200,
          iid: 5,
          title: 'newer issue',
          state: 'opened',
          updated_at: '2026-05-08T00:00:00Z'
        }
      ])
    })

    const result = await listWorkItems('/repo', 'opened', 1, 20)
    expect(result.items.map((i) => i.title)).toEqual(['newer issue', 'older mr'])
    expect(result.items[0].type).toBe('issue')
    expect(result.items[1].type).toBe('mr')
  })

  it("skips the issues fetch when state === 'merged'", async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({
      body: '[]',
      headers: { 'x-total': '0', 'x-total-pages': '0' }
    })

    await listWorkItems('/repo', 'merged', 1, 20)
    // Why: the merged-state filter doesn't apply to issues (issues
    // don't have a merged lifecycle), so the IPC must not even spawn
    // the issues read. Verifies the listIssues path was not taken.
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('passes the closed state through to the issues fetch', async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo', 'closed', 1, 20)
    const issuesCallPath = glabExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(issuesCallPath[1]).toContain('state=closed')
  })

  it("omits the state param when 'all'", async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo', 'all', 1, 20)
    const issuesCallPath = glabExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(issuesCallPath[1]).not.toContain('state=')
  })

  it('returns a not_found error envelope when project ref is unresolved', async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({ source: null, fellBack: false })

    const result = await listWorkItems('/repo', 'opened')
    expect(result.error?.type).toBe('not_found')
    expect(result.items).toEqual([])
    expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('surfaces the MR error envelope into the combined result', async () => {
    glabApiWithHeadersMock.mockRejectedValueOnce(new Error('HTTP 403 Forbidden'))
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    const result = await listWorkItems('/repo', 'opened', 1, 20)
    expect(result.error?.type).toBe('permission_denied')
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
})
