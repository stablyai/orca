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

import { getAuthenticatedViewer, getWorkItemByProjectRef } from './client'

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
})
