import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const { glabExecFileAsyncMock, getGlabKnownHostsMock, acquireMock, releaseMock } = vi.hoisted(
  () => ({
    glabExecFileAsyncMock: vi.fn(),
    getGlabKnownHostsMock: vi.fn(),
    acquireMock: vi.fn(),
    releaseMock: vi.fn()
  })
)

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import { getAuthenticatedViewer, getWorkItemByProjectRef, listTodos } from './client'

describe('gitlab client — viewer & paste-URL lookup', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
  })

  describe('getAuthenticatedViewer', () => {
    it('returns username + email when glab api user succeeds', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ username: 'alice', email: 'alice@example.com' })
      })
      await expect(getAuthenticatedViewer()).resolves.toEqual({
        username: 'alice',
        email: 'alice@example.com'
      })
    })

    it('coerces a missing email to null', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ username: 'alice', email: null })
      })
      await expect(getAuthenticatedViewer()).resolves.toEqual({
        username: 'alice',
        email: null
      })
    })

    it('returns null when glab fails', async () => {
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('not authenticated'))
      await expect(getAuthenticatedViewer()).resolves.toBeNull()
    })

    it('returns null when username is empty', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({ username: '   ', email: null })
      })
      await expect(getAuthenticatedViewer()).resolves.toBeNull()
    })
  })

  describe('getWorkItemByProjectRef', () => {
    it('fetches an MR and maps to GitLabWorkItem', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 100,
          iid: 5,
          title: 't',
          state: 'opened',
          web_url: 'https://gitlab.com/g/p/-/merge_requests/5',
          source_branch: 'feat',
          target_branch: 'main'
        })
      })
      const item = await getWorkItemByProjectRef(
        '/repo',
        { host: 'gitlab.com', path: 'g/p' },
        5,
        'mr'
      )
      expect(item).toMatchObject({ type: 'mr', number: 5, branchName: 'feat' })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', 'projects/g%2Fp/merge_requests/5'],
        { cwd: '/repo' }
      )
    })

    it('fetches an issue and maps to GitLabWorkItem', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 200,
          iid: 9,
          title: 'bug',
          state: 'opened',
          web_url: 'https://gitlab.com/g/p/-/issues/9'
        })
      })
      const item = await getWorkItemByProjectRef(
        '/repo',
        { host: 'gitlab.com', path: 'g/p' },
        9,
        'issue'
      )
      expect(item).toMatchObject({ type: 'issue', number: 9 })
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['api', 'projects/g%2Fp/issues/9'], {
        cwd: '/repo'
      })
    })

    it('returns null when the API errors', async () => {
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('not found'))
      const item = await getWorkItemByProjectRef(
        '/repo',
        { host: 'gitlab.com', path: 'g/p' },
        9,
        'issue'
      )
      expect(item).toBeNull()
    })
  })

  describe('listTodos', () => {
    it('maps glab todos response to GitLabTodo shape', async () => {
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 1,
            action_name: 'assigned',
            target_type: 'MergeRequest',
            target: {
              iid: 42,
              title: 'Add feature',
              web_url: 'https://gitlab.com/g/p/-/merge_requests/42'
            },
            target_url: 'https://gitlab.com/g/p/-/merge_requests/42',
            author: { username: 'alice', avatar_url: 'https://example.com/a.png' },
            project: { path_with_namespace: 'g/p' },
            updated_at: '2026-05-08T10:00:00Z',
            state: 'pending'
          }
        ])
      })

      await expect(listTodos('/repo')).resolves.toEqual([
        {
          id: 1,
          actionName: 'assigned',
          targetType: 'MergeRequest',
          targetIid: 42,
          targetTitle: 'Add feature',
          targetUrl: 'https://gitlab.com/g/p/-/merge_requests/42',
          projectPath: 'g/p',
          authorUsername: 'alice',
          authorAvatarUrl: 'https://example.com/a.png',
          updatedAt: '2026-05-08T10:00:00Z',
          state: 'pending'
        }
      ])
      expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
        ['api', '--paginate', 'todos?state=pending&per_page=50'],
        { cwd: '/repo' }
      )
    })

    it('coerces non-pending state values to pending (defensive)', async () => {
      // Why: we filter to state=pending in the request, but if a future
      // glab change leaks a different state through, the type's narrow
      // 'pending' | 'done' union should still hold — anything not 'done'
      // collapses to 'pending' rather than violating the type.
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([
          { id: 2, action_name: 'mentioned', target_type: 'Issue', state: 'weird' }
        ])
      })
      const result = await listTodos('/repo')
      expect(result[0].state).toBe('pending')
    })

    it('falls back to empty list when glab errors', async () => {
      glabExecFileAsyncMock.mockRejectedValueOnce(new Error('auth failed'))
      await expect(listTodos('/repo')).resolves.toEqual([])
    })

    it('handles missing target / project / author fields gracefully', async () => {
      // Why: GitLab Todos for Commit / Note targets sometimes omit
      // `target` entirely — defaults must keep the record well-formed
      // so the renderer doesn't choke on .title access.
      glabExecFileAsyncMock.mockResolvedValueOnce({
        stdout: JSON.stringify([{ id: 3, action_name: 'build_failed', target_type: 'Commit' }])
      })
      const result = await listTodos('/repo')
      expect(result[0]).toMatchObject({
        targetIid: null,
        targetTitle: '',
        targetUrl: '',
        projectPath: '',
        authorUsername: '',
        authorAvatarUrl: ''
      })
    })
  })
})
