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

import {
  _getGitLabRateLimitCacheSize,
  _resetGitLabRateLimitCache,
  addMRComment,
  getMergeRequest,
  getMergeRequestForBranch,
  getJobTrace,
  addMRInlineComment,
  closeMR,
  diagnoseAuth,
  getRateLimit,
  listMergeRequests,
  listWorkItems,
  mergeMR,
  reopenMR,
  resolveMRDiscussion,
  retryJob,
  updateMR,
  updateMRReviewers
} from './client'

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
    _resetGitLabRateLimitCache()
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  it('routes local WSL MR review-management and job actions through project resolution and glab options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '{}' })
      .mockResolvedValueOnce({ stdout: '{}' })
      .mockResolvedValueOnce({ stdout: '{}' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 1,
          author: { username: 'alice', avatar_url: '', state: 'active' },
          body: 'Comment',
          created_at: '2026-06-16T00:00:00.000Z'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'discussion-1',
          notes: [
            {
              id: 2,
              author: { username: 'alice', avatar_url: '', state: 'active' },
              body: 'Inline',
              created_at: '2026-06-16T00:00:00.000Z',
              position: { new_path: 'src/app.ts', new_line: 12 }
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stdout: '{}' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          reviewers: [{ id: 1, username: 'alice', name: 'Alice', avatar_url: '', state: 'active' }]
        })
      })
      .mockResolvedValueOnce({ stdout: 'trace output' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 100,
          pipeline: { id: 50 },
          name: 'test',
          stage: 'test',
          status: 'pending',
          web_url: 'https://gitlab.com/g/p/-/jobs/100',
          duration: null
        })
      })
      .mockResolvedValueOnce({ stdout: '{}' })

    await closeMR('/repo', 12, undefined, null, undefined, localGitOptions)
    await reopenMR('/repo', 12, undefined, null, undefined, localGitOptions)
    await mergeMR('/repo', 12, 'squash', undefined, null, undefined, localGitOptions)
    await addMRComment('/repo', 12, 'Comment', undefined, null, undefined, localGitOptions)
    await addMRInlineComment(
      '/repo',
      12,
      {
        body: 'Inline',
        path: 'src/app.ts',
        line: 12,
        baseSha: 'base',
        startSha: 'start',
        headSha: 'head'
      },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    await resolveMRDiscussion(
      '/repo',
      12,
      'discussion-1',
      true,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    await updateMRReviewers('/repo', 12, [1], undefined, null, undefined, localGitOptions)
    await getJobTrace('/repo', 99, undefined, null, undefined, localGitOptions)
    await retryJob('/repo', 99, undefined, null, undefined, localGitOptions)
    await updateMR('/repo', 12, { title: 'Renamed' }, undefined, null, undefined, localGitOptions)

    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo',
      undefined,
      ['gitlab.com'],
      null,
      localGitOptions
    )
    expect(glabExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
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

  describe('diagnoseAuth', () => {
    it('reports glab hosts from auth status', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.com as alice\n',
        stderr: ''
      })

      await expect(diagnoseAuth()).resolves.toMatchObject({
        glabAvailable: true,
        authenticated: true,
        hosts: ['gitlab.com'],
        activeHost: 'gitlab.com'
      })
    })
  })

  describe('getRateLimit', () => {
    it('parses GitLab REST budget headers', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({
        body: '{}',
        headers: {
          'ratelimit-limit': '2000',
          'ratelimit-remaining': '1997',
          'ratelimit-reset': '1780000000'
        }
      })

      await expect(
        getRateLimit({ host: 'gitlab.example.com', force: true })
      ).resolves.toMatchObject({
        ok: true,
        snapshot: {
          host: 'gitlab.example.com',
          rest: {
            limit: 2000,
            remaining: 1997,
            resetAt: 1780000000
          }
        }
      })
      expect(glabApiWithHeadersMock).toHaveBeenCalledWith([
        '--hostname',
        'gitlab.example.com',
        'user'
      ])
    })

    it('reports a null bucket when the host omits rate-limit headers', async () => {
      glabApiWithHeadersMock.mockResolvedValueOnce({ body: '{}', headers: {} })

      await expect(getRateLimit({ force: true })).resolves.toMatchObject({
        ok: true,
        snapshot: { host: null, rest: null }
      })
    })

    it('bounds cached rate-limit snapshots across many hosts', async () => {
      glabApiWithHeadersMock.mockResolvedValue({ body: '{}', headers: {} })

      for (let i = 0; i < 70; i++) {
        await getRateLimit({ host: `gitlab-${i}.example.com`, force: true })
      }

      expect(_getGitLabRateLimitCacheSize()).toBe(64)
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

    it('uses legacy pipeline payloads when branch MR lists omit head_pipeline', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 8,
            title: 'Legacy pipeline branch',
            state: 'opened',
            sha: 'def',
            pipeline: { status: 'failed' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/legacy-pipeline')
      expect(mr?.number).toBe(8)
      expect(mr?.pipelineStatus).toBe('failure')
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

    it('routes local WSL merge-request branch lookup through the selected distro', async () => {
      getProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'g/p' })
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 12,
            title: 'WSL branch',
            state: 'opened',
            sha: 'abc',
            head_pipeline: { status: 'success' }
          }
        ])
      })

      const mr = await getMergeRequestForBranch('/repo', 'feature/wsl', null, null, {
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })

      expect(mr?.number).toBe(12)
      expect(getProjectRefMock).toHaveBeenCalledWith('/repo', ['gitlab.com'], null, {
        wslDistro: 'Ubuntu'
      })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(expect.any(Array), {
        cwd: '/repo',
        wslDistro: 'Ubuntu'
      })
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

  describe('resolveMRDiscussion', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'git.internal', path: 'g/p' },
        fellBack: false
      }))
    })

    it('updates the discussion resolved state through the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

      await expect(
        resolveMRDiscussion('/repo', 12, 'discussion-1', true, 'upstream', 'conn-1')
      ).resolves.toEqual({ ok: true })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          '--hostname',
          'git.internal',
          '-X',
          'PUT',
          'projects/g%2Fp/merge_requests/12/discussions/discussion-1',
          '-f',
          'resolved=true'
        ],
        {}
      )
    })

    it('rejects an empty discussion id without calling glab', async () => {
      await expect(resolveMRDiscussion('/repo', 12, '  ', true)).resolves.toEqual({
        ok: false,
        error: 'Discussion id is required'
      })

      expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    })
  })

  describe('addMRInlineComment', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'git.internal', path: 'g/p' },
        fellBack: false
      }))
    })

    it('posts an inline discussion with GitLab position fields', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 'discussion-1',
          notes: [
            {
              id: 500,
              author: { username: 'alice', avatar_url: 'https://example.com/a.png' },
              body: 'please fix',
              created_at: '2026-05-05T10:00:00Z',
              position: { new_path: 'src/app.ts', new_line: 12 }
            }
          ]
        })
      })

      await expect(
        addMRInlineComment(
          '/repo',
          12,
          {
            body: 'please fix',
            path: 'src/app.ts',
            line: 12,
            baseSha: 'base',
            startSha: 'start',
            headSha: 'head'
          },
          'upstream',
          'conn-1'
        )
      ).resolves.toMatchObject({
        ok: true,
        comment: {
          id: 500,
          threadId: 'discussion-1',
          path: 'src/app.ts',
          line: 12
        }
      })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          '--hostname',
          'git.internal',
          '-X',
          'POST',
          'projects/g%2Fp/merge_requests/12/discussions',
          '-f',
          'body=please fix',
          '-f',
          'position[position_type]=text',
          '-f',
          'position[base_sha]=base',
          '-f',
          'position[start_sha]=start',
          '-f',
          'position[head_sha]=head',
          '-f',
          'position[old_path]=src/app.ts',
          '-f',
          'position[new_path]=src/app.ts',
          '-f',
          'position[new_line]=12'
        ],
        {}
      )
    })
  })

  describe('job CI operations', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'git.internal', path: 'g/p' },
        fellBack: false
      }))
    })

    it('fetches a job trace through the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'trace output' })

      await expect(getJobTrace('/repo', 99, 'upstream', 'conn-1')).resolves.toEqual({
        ok: true,
        trace: 'trace output'
      })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', '--hostname', 'git.internal', 'projects/g%2Fp/jobs/99/trace'],
        {}
      )
    })

    it('retries a job through the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 100,
          pipeline: { id: 50 },
          name: 'test',
          stage: 'test',
          status: 'pending',
          web_url: 'https://git.internal/g/p/-/jobs/100',
          duration: null
        })
      })

      await expect(retryJob('/repo', 99, 'upstream', 'conn-1')).resolves.toEqual({
        ok: true,
        job: {
          id: 100,
          pipelineId: 50,
          name: 'test',
          stage: 'test',
          status: 'pending',
          webUrl: 'https://git.internal/g/p/-/jobs/100',
          duration: null
        }
      })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', '--hostname', 'git.internal', '-X', 'POST', 'projects/g%2Fp/jobs/99/retry'],
        {}
      )
    })
  })

  describe('updateMRReviewers', () => {
    beforeEach(() => {
      resolveIssueSourceMock.mockImplementation(async () => ({
        source: { host: 'git.internal', path: 'g/p' },
        fellBack: false
      }))
    })

    it('sets reviewers through reviewer_ids on the selected SSH GitLab host', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          reviewers: [
            {
              id: 1,
              username: 'alice',
              name: 'Alice',
              avatar_url: 'https://example.com/a.png',
              state: 'active'
            }
          ]
        })
      })

      await expect(updateMRReviewers('/repo', 12, [1], 'upstream', 'conn-1')).resolves.toEqual({
        ok: true,
        reviewers: [
          {
            id: 1,
            username: 'alice',
            name: 'Alice',
            avatarUrl: 'https://example.com/a.png',
            state: 'active'
          }
        ]
      })

      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          '--hostname',
          'git.internal',
          '-X',
          'PUT',
          'projects/g%2Fp/merge_requests/12',
          '-f',
          'reviewer_ids[]=1'
        ],
        {}
      )
    })
  })
})
