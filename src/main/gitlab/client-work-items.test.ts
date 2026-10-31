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

  it('merges and sorts MRs + issues while preserving unknown-total page continuation', async () => {
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
        },
        {
          id: 101,
          iid: 2,
          title: 'newest mr',
          state: 'opened',
          updated_at: '2026-05-09T00:00:00Z',
          source_project_id: 5,
          target_project_id: 5
        }
      ]),
      headers: {}
    })
    glabExecFileAsyncMock.mockImplementation(async () => {
      return {
        stdout: JSON.stringify([
          {
            id: 200,
            iid: 5,
            title: 'newer issue',
            state: 'opened',
            updated_at: '2026-05-08T00:00:00Z'
          }
        ])
      }
    })

    const result = await listWorkItems('/repo', 'opened', 3, 2)
    expect(result).toMatchObject({ page: 3, perPage: 2, totalCount: 0, totalPages: 4 })
    expect(result.error).toBeUndefined()
    expect(result.items.map(({ title, type }) => ({ title, type }))).toEqual([
      { title: 'newest mr', type: 'mr' },
      { title: 'newer issue', type: 'issue' },
      { title: 'older mr', type: 'mr' }
    ])
    expect(glabApiWithHeadersMock).toHaveBeenCalledTimes(1)

    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
    expect(await listWorkItems('/repo', 'opened', 4, 2)).toEqual({
      items: [],
      page: 4,
      perPage: 2,
      totalCount: 0,
      totalPages: 4
    })
  })

  it('passes search queries through to merge request and issue fetches', async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo', 'opened', 1, 20, undefined, 'ambiguous selector')

    const mergeRequestCallPath = glabApiWithHeadersMock.mock.calls[0][0] as string[]
    const issuesCallPath = glabExecFileAsyncMock.mock.calls[0][0] as string[]
    expect(mergeRequestCallPath[0]).toContain('search=ambiguous%20selector')
    expect(issuesCallPath.at(-1)).toContain('search=ambiguous%20selector')
  })

  it('looks up `#N` as the issue iid instead of a text search', async () => {
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo', 'opened', 1, 20, undefined, ' #23 ')

    const issuesCallPath = glabExecFileAsyncMock.mock.calls[0][0] as string[]
    const issueParams = new URLSearchParams(issuesCallPath.at(-1)?.split('?')[1])
    expect(issueParams.getAll('iids[]')).toEqual(['23'])
    expect(issueParams.has('search')).toBe(false)
  })

  it('routes issue list fetches through the selected SSH GitLab host', async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { host: 'git.internal', path: 'g/p' },
      fellBack: false
    })
    glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo', 'opened', 1, 20, 'upstream', undefined, 'conn-1')

    expect(glabExecFileAsyncMock.mock.calls[0][0]).toEqual([
      'api',
      '--hostname',
      'git.internal',
      'projects/g%2Fp/issues?page=1&per_page=20&order_by=updated_at&sort=desc&state=opened'
    ])
  })

  it('returns a not_found error envelope when project ref is unresolved', async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({ source: null, fellBack: false })

    const result = await listWorkItems('/repo', 'opened')
    expect(result.error?.type).toBe('not_found')
    expect(result.items).toEqual([])
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
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
