/* eslint-disable max-lines -- Why: GitLab MR operation tests share one hoisted
   gl-utils mock; splitting the file would duplicate brittle mock setup. */
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

import { getMergeRequest, getMergeRequestForBranch, listMergeRequests, updateMR } from './client'

describe('gitlab client — MR operations', () => {
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
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  describe('getMergeRequest', () => {
    it('fetches the MR with rolled-up pipeline status', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 10,
          title: 'Add feature',
          state: 'opened',
          web_url: 'https://gitlab.com/g/p/-/merge_requests/10',
          updated_at: '2026-05-05T00:00:00Z',
          sha: 'deadbeef',
          head_pipeline: { status: 'success' },
          detailed_merge_status: 'mergeable'
        })
      })
      const mr = await getMergeRequest('/repo', 10)
      expect(mr).toMatchObject({
        number: 10,
        title: 'Add feature',
        state: 'opened',
        url: 'https://gitlab.com/g/p/-/merge_requests/10',
        pipelineStatus: 'success',
        mergeable: 'MERGEABLE',
        headSha: 'deadbeef'
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/10'],
        { cwd: '/repo' }
      )
    })

    it('falls back to `glab mr view` when project ref is unresolved', async () => {
      getProjectRefMock.mockResolvedValueOnce(null)
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ iid: 5, title: 't', state: 'opened' })
      })
      await getMergeRequest('/repo', 5)
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['mr', 'view', '5', '--output', 'json'], {
        cwd: '/repo'
      })
    })

    it('returns null when glab errors', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('not found'))
      await expect(getMergeRequest('/repo', 99)).resolves.toBeNull()
    })

    it('treats neutral pipeline (no head_pipeline) as neutral status', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 1,
          title: 't',
          state: 'opened',
          head_pipeline: null
        })
      })
      const mr = await getMergeRequest('/repo', 1)
      expect(mr?.pipelineStatus).toBe('neutral')
    })
  })

  describe('getMergeRequestForBranch', () => {
    it('finds the most recently updated MR for a branch across states', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 7,
            title: 'WIP',
            state: 'merged',
            sha: 'abc',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/foo')
      expect(mr?.number).toBe(7)
      expect(mr?.state).toBe('merged')
      expect(mr?.pipelineStatus).toBe('success')
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          'projects/g%2Fp/merge_requests?source_branch=feature%2Ffoo&order_by=updated_at&sort=desc&per_page=1'
        ],
        { cwd: '/repo' }
      )
    })

    it('strips refs/heads/ prefix from the branch arg', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

      await getMergeRequestForBranch('/repo', 'refs/heads/feature/bar')
      const callArgs = glabExecFileAsyncMock.mock.calls[0][0] as string[]
      expect(callArgs[1]).toContain('source_branch=feature%2Fbar')
    })

    it('returns null when no MR matches the branch', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
      await expect(getMergeRequestForBranch('/repo', 'feature')).resolves.toBeNull()
    })

    it('falls back to a linked MR iid when the branch lookup misses', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: JSON.stringify({
          iid: 9,
          title: 'Linked MR',
          state: 'opened',
          pipeline: { status: 'success' }
        })
      })

      const mr = await getMergeRequestForBranch('/repo', 'local-review-branch', 9)
      expect(mr?.number).toBe(9)
      expect(mr?.pipelineStatus).toBe('success')
      expect(glabExecFileAsyncMock).toHaveBeenLastCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/9'],
        { cwd: '/repo' }
      )
    })

    it('returns null for an empty / detached-HEAD branch arg', async () => {
      // Why: during a rebase the branch is empty — mirror github/getPRForBranch's
      // early return without calling glab.
      await expect(getMergeRequestForBranch('/repo', '')).resolves.toBeNull()
      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    })

    it('returns null when project ref cannot be resolved', async () => {
      getProjectRefMock.mockResolvedValueOnce(null)
      await expect(getMergeRequestForBranch('/repo', 'feature')).resolves.toBeNull()
      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
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
  })

  describe('updateMR', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'git.internal', path: 'g/p' },
        fellBack: false
      }))
    })

    it('updates title, body, and labels through the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

      await expect(
        updateMR(
          '/repo',
          12,
          {
            title: 'Renamed',
            body: 'Updated body',
            addLabels: ['bug'],
            removeLabels: ['stale']
          },
          'upstream',
          'conn-1'
        )
      ).resolves.toEqual({ ok: true })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          '--hostname',
          'git.internal',
          '-X',
          'PUT',
          'projects/g%2Fp/merge_requests/12',
          '-f',
          'title=Renamed',
          '-f',
          'description=Updated body',
          '-f',
          'add_labels=bug',
          '-f',
          'remove_labels=stale'
        ],
        {}
      )
    })
  })
})
