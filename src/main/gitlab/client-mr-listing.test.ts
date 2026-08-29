import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const {
  glabExecFileAsyncMock,
  glabApiWithHeadersMock,
  getGlabKnownHostsMock,
  getProjectRefMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock,
  gitExecFileAsyncMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  getProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

// Why: the #9171 default-branch guard resolves the repo default branch via
// git; keep those probes hermetic instead of spawning real git processes.
vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
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

import { listMergeRequests, listWorkItems } from './client'
import { resetGitLabMrMocks } from './client-mr-test-harness'

describe('gitlab client — MR operations', () => {
  beforeEach(() => {
    resetGitLabMrMocks({
      glabExecFileAsyncMock,
      glabApiWithHeadersMock,
      getGlabKnownHostsMock,
      getProjectRefMock,
      resolveIssueSourceMock,
      acquireMock,
      releaseMock,
      gitExecFileAsyncMock
    })
  })

  describe('listMergeRequests', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'gitlab.com', path: 'g/p' },
        fellBack: false
      }))
    })

    it('returns MRs via the GitLab API', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: JSON.stringify([
          {
            id: 100,
            iid: 1,
            title: 'first',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/1',
            updated_at: '2026-05-05',
            source_branch: 'feat-1',
            target_branch: 'main',
            author: { username: 'alice' },
            source_project_id: 5,
            target_project_id: 5
          }
        ]),
        headers: { 'x-total': '1', 'x-total-pages': '1' }
      })

      const result = await listMergeRequests('/repo', 'opened', 1, 20)
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        type: 'mr',
        number: 1,
        title: 'first',
        state: 'opened',
        branchName: 'feat-1',
        baseRefName: 'main',
        author: 'alice',
        isCrossRepository: false,
        repoId: 'g/p'
      })
      expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
        [
          'projects/g%2Fp/merge_requests?page=1&per_page=20&order_by=updated_at&sort=desc&with_merge_status_recheck=false&state=opened'
        ],
        { cwd: '/repo' }
      )
    })

    it('routes local WSL MR listing through project resolution and glab API options', async () => {
      const localGitOptions = { wslDistro: 'Ubuntu' }
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })

      await listMergeRequests('/repo', 'opened', 1, 20, undefined, undefined, null, localGitOptions)

      expect(resolveIssueSourceMock).toHaveBeenCalledWith(
        '/repo',
        undefined,
        ['gitlab.com'],
        null,
        localGitOptions
      )
      expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
        [
          'projects/g%2Fp/merge_requests?page=1&per_page=20&order_by=updated_at&sort=desc&with_merge_status_recheck=false&state=opened'
        ],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      )
    })

    it('routes local WSL combined work-item listing through MR and issue glab options', async () => {
      const localGitOptions = { wslDistro: 'Ubuntu' }
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

      await listWorkItems('/repo', 'opened', 1, 20, undefined, undefined, null, localGitOptions)

      expect(resolveIssueSourceMock).toHaveBeenCalledWith(
        '/repo',
        undefined,
        ['gitlab.com'],
        null,
        localGitOptions
      )
      expect(glabApiWithHeadersMock).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
      )
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ cwd: '/repo', wslDistro: 'Ubuntu' })
      )
    })

    it("omits state when state='all'", async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })

      await listMergeRequests('/repo', 'all', 1, 20)
      const callArgs = glabApiWithHeadersMock.mock.calls[0][0] as string[]
      expect(callArgs[0]).not.toContain('state=')
    })

    it('passes through Open / Merged / Closed states as API params', async () => {
      for (const state of ['opened', 'merged', 'closed'] as const) {
        glabApiWithHeadersMock.mockReset()
        glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
        await listMergeRequests('/repo', state, 1, 20)
        const callArgs = glabApiWithHeadersMock.mock.calls[0][0] as string[]
        expect(callArgs[0]).toContain(`state=${state}`)
      }
    })

    it('appends an encoded &search= param when a query is supplied', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
      await listMergeRequests('/repo', 'opened', 1, 20, undefined, 'fix login')
      const callArgs = glabApiWithHeadersMock.mock.calls[0][0] as string[]
      expect(callArgs[0]).toContain('&search=fix%20login')
    })

    it('omits &search= for an empty or whitespace-only query', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '[]', headers: {} })
      await listMergeRequests('/repo', 'opened', 1, 20, undefined, '   ')
      const callArgs = glabApiWithHeadersMock.mock.calls[0][0] as string[]
      expect(callArgs[0]).not.toContain('search=')
    })

    it('flags fork MRs as cross-repository', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: JSON.stringify([
          {
            id: 200,
            iid: 2,
            title: 'fork mr',
            state: 'opened',
            source_branch: 'feat',
            target_branch: 'main',
            source_project_id: 11,
            target_project_id: 5
          }
        ]),
        headers: {}
      })

      const result = await listMergeRequests('/repo', 'opened', 1, 20)
      expect(result.items[0].isCrossRepository).toBe(true)
    })

    it('falls back to glab mr list when project ref is unresolved', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: null,
        fellBack: false
      })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 300,
            iid: 3,
            title: 'fallback mr',
            state: 'opened',
            web_url: 'https://gitlab.com/-/merge_requests/3',
            updated_at: '2026-05-05',
            source_project_id: 5,
            target_project_id: 5
          }
        ])
      })
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.items).toHaveLength(1)
      expect(result.items[0].title).toBe('fallback mr')
      expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'mr',
          'list',
          '--output',
          'json',
          '--per-page',
          '20',
          '--page',
          '1',
          '--order',
          'updated_at',
          '--sort',
          'desc'
        ],
        { cwd: '/repo' }
      )
    })

    it('threads --search into the cwd fallback when a query is supplied', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: null,
        fellBack: false
      })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
      await listMergeRequests('/repo', 'opened', 1, 20, undefined, 'fix login')
      expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
      const callArgs = glabExecFileAsyncMock.mock.calls[0][0] as string[]
      // Why (#6263): the cwd-inferred fallback must honor the typed query too.
      const searchIdx = callArgs.indexOf('--search')
      expect(searchIdx).toBeGreaterThanOrEqual(0)
      expect(callArgs[searchIdx + 1]).toBe('fix login')
    })

    it('omits --search from the cwd fallback for a whitespace-only query', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: null,
        fellBack: false
      })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
      await listMergeRequests('/repo', 'opened', 1, 20, undefined, '   ')
      const callArgs = glabExecFileAsyncMock.mock.calls[0][0] as string[]
      expect(callArgs).not.toContain('--search')
    })

    it('classifies fallback errors into the result envelope', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: null,
        fellBack: false
      })
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 403 Forbidden'))
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.error?.type).toBe('permission_denied')
      expect(result.items).toEqual([])
      expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
    })

    it('does not run the cwd fallback for unresolved SSH repos', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: null,
        fellBack: false
      })
      const result = await listMergeRequests(
        '/remote/repo',
        'opened',
        1,
        20,
        undefined,
        undefined,
        'conn-1'
      )
      expect(result.error?.type).toBe('not_found')
      expect(result.items).toEqual([])
      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
      expect(glabApiWithHeadersMock).not.toHaveBeenCalled()
    })

    it('classifies API errors into the result envelope', async () => {
      glabApiWithHeadersMock.mockRejectedValueOnce(new Error('HTTP 403 Forbidden'))
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.error?.type).toBe('permission_denied')
      expect(result.items).toEqual([])
    })

    // Why: the title carries a classifier keyword, so this also pins that a wrapped payload stays
    // out of the substring matcher — classifying it would swap the body for "check your connection".
    it('reports the body instead of ".map is not a function" when the API returns a non-array', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: JSON.stringify({ data: [{ iid: 7, title: 'fix network timeout' }] }),
        headers: {}
      })
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.items).toEqual([])
      expect(result.error?.type).toBe('unknown')
      expect(result.error?.message).toContain('fix network timeout')
      expect(result.error?.message).not.toContain('is not a function')
    })

    it('reports the body instead of ".map is not a function" when the cwd fallback returns a non-array', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({ source: null, fellBack: false })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ data: [], total: 0 })
      })
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.items).toEqual([])
      expect(result.error?.message).toContain('{"data":[],"total":0}')
      expect(result.error?.message).not.toContain('is not a function')
    })

    // Why: the whole point of surfacing the body — a GitLab error envelope now
    // classifies like any other glab failure instead of collapsing to 'unknown'.
    it('classifies a GitLab error envelope returned on exit 0', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: JSON.stringify({ message: '403 Forbidden' }),
        headers: {}
      })
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.items).toEqual([])
      expect(result.error?.type).toBe('permission_denied')
    })

    // Why: the sibling title matches an earlier classifier branch than the envelope does, so this
    // fails if the payload leaks into classification instead of only the envelope's own message.
    it('classifies an error envelope by its message, not its sibling payload', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: JSON.stringify({
          message: '404 Project Not Found',
          data: [{ iid: 7, title: '403 forbidden in CI' }]
        }),
        headers: {}
      })
      const result = await listMergeRequests('/repo', 'opened')
      expect(result.error?.type).toBe('not_found')
    })
  })
})
