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

import {
  addMRComment,
  getJobTrace,
  addMRInlineComment,
  closeMR,
  mergeMR,
  reopenMR,
  resolveMRDiscussion,
  retryJob,
  updateMR,
  updateMRReviewers
} from './client'
import { resetGitLabMrMocks } from './client-mr-test-harness'
import { stripGitLabDraftTitlePrefix } from './merge-request-draft-title'

describe('stripGitLabDraftTitlePrefix', () => {
  it.each([
    ['Draft: Ship it', 'Ship it'],
    ['wip:   Ship it', 'Ship it'],
    ['[Draft] Ship it', 'Ship it'],
    ['(WIP)Ship it', 'Ship it'],
    ['Draft - Ship it', 'Ship it']
  ])('strips a GitLab draft marker from %s', (title, expected) => {
    expect(stripGitLabDraftTitlePrefix(title)).toBe(expected)
  })

  it('leaves markerless titles unchanged', () => {
    expect(stripGitLabDraftTitlePrefix('Ship it')).toBeNull()
  })
})

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

    it('fetches the current title before marking a merge request ready', async () => {
      glabExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: JSON.stringify({ title: 'Draft: Fresh title' }) })
        .mockResolvedValueOnce({ stdout: '{}' })

      await expect(
        updateMR('/repo', 12, { readyForReview: true }, 'upstream', 'conn-1')
      ).resolves.toEqual({ ok: true })

      expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(
        1,
        ['api', '--hostname', 'git.internal', 'projects/g%2Fp/merge_requests/12'],
        {}
      )
      expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(
        2,
        [
          'api',
          '--hostname',
          'git.internal',
          '-X',
          'PUT',
          'projects/g%2Fp/merge_requests/12',
          '-f',
          'title=Fresh title'
        ],
        {}
      )
    })

    it('treats a freshly markerless title as already ready', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ title: 'Fresh title' })
      })

      await expect(
        updateMR('/repo', 12, { readyForReview: true }, 'upstream', 'conn-1')
      ).resolves.toEqual({ ok: true })

      expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    })

    it('rejects a draft marker that would leave an empty title', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify({ title: 'Draft:' }) })

      await expect(
        updateMR('/repo', 12, { readyForReview: true }, 'upstream', 'conn-1')
      ).resolves.toEqual({ ok: false, error: 'Title is required' })

      expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
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
