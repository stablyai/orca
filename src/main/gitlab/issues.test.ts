import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const {
  glabExecFileAsyncMock,
  getIssueProjectRefMock,
  resolveIssueSourceMock,
  getGlabKnownHostsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getIssueProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    getIssueProjectRef: getIssueProjectRefMock,
    resolveIssueSource: resolveIssueSourceMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import { addIssueComment, createIssue, getIssue, listIssues, updateIssue } from './issues'

describe('gitlab issue operations', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getIssueProjectRefMock.mockReset()
    resolveIssueSourceMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueProjectRefMock(),
      fellBack: false
    }))
  })

  it('gets a single issue from the project ref', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        iid: 923,
        title: 'Use upstream issues',
        state: 'opened',
        web_url: 'https://gitlab.com/stablyai/orca/-/issues/923',
        labels: []
      })
    })

    await expect(getIssue('/repo-root', 923)).resolves.toMatchObject({ number: 923 })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'projects/stablyai%2Forca/issues/923'],
      { cwd: '/repo-root' }
    )
  })

  it('encodes nested group paths', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({
      host: 'gitlab.com',
      path: 'group/subgroup/project'
    })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ iid: 1, title: 't', state: 'opened' })
    })

    await getIssue('/repo-root', 1)
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'projects/group%2Fsubgroup%2Fproject/issues/1'],
      { cwd: '/repo-root' }
    )
  })

  it('lists issues with state=opened ordering', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await expect(listIssues('/repo-root', 5)).resolves.toEqual({ items: [] })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        'projects/stablyai%2Forca/issues?per_page=5&order_by=updated_at&sort=desc&state=opened'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('surfaces a permission_denied error instead of collapsing to empty', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 403 Forbidden'))

    const result = await listIssues('/repo-root', 5)

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('permission_denied')
  })

  it('creates an issue and returns its iid + web_url', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        iid: 924,
        web_url: 'https://gitlab.com/stablyai/orca/-/issues/924'
      })
    })

    await expect(createIssue('/repo-root', 'New issue', 'Body')).resolves.toEqual({
      ok: true,
      number: 924,
      url: 'https://gitlab.com/stablyai/orca/-/issues/924'
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'projects/stablyai%2Forca/issues',
        '-f',
        'title=New issue',
        '-f',
        'description=Body'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('rejects createIssue with empty title', async () => {
    await expect(createIssue('/repo-root', '   ', 'body')).resolves.toEqual({
      ok: false,
      error: 'Title is required'
    })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('updateIssue closes via `glab issue close` when state=closed', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toEqual({ ok: true })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'close', '5', '-R', 'stablyai/orca'],
      { cwd: '/repo-root' }
    )
  })

  it("updateIssue treats 'already closed' as a no-op", async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('Issue is already closed'))

    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toEqual({ ok: true })
  })

  it('updateIssue applies field edits via `glab issue update`', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 5, {
        title: 'Renamed',
        addLabels: ['bug'],
        removeLabels: ['stale'],
        addAssignees: ['alice'],
        removeAssignees: ['bob']
      })
    ).resolves.toEqual({ ok: true })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'issue',
        'update',
        '5',
        '-R',
        'stablyai/orca',
        '--title',
        'Renamed',
        '--label',
        'bug',
        '--unlabel',
        'stale',
        '--assignee',
        'alice',
        '--unassignee',
        'bob'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('addIssueComment posts to /notes and maps the response', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 100,
        author: { username: 'alice', avatar_url: 'https://example.com/a.png' },
        body: 'Hello',
        created_at: '2026-05-05T10:00:00Z'
      })
    })

    const result = await addIssueComment('/repo-root', 5, 'Hello')
    expect(result).toEqual({
      ok: true,
      comment: {
        id: 100,
        author: 'alice',
        authorAvatarUrl: 'https://example.com/a.png',
        body: 'Hello',
        createdAt: '2026-05-05T10:00:00Z',
        url: '',
        isBot: false
      }
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '-X', 'POST', 'projects/stablyai%2Forca/issues/5/notes', '-f', 'body=Hello'],
      { cwd: '/repo-root' }
    )
  })

  it('returns null from getIssue when project ref cannot be resolved', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce(null)
    // Why: when there's no GitLab project ref the fallback path
    // (`glab issue view` from cwd) runs — simulate a glab failure to ensure
    // we surface null cleanly.
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('not a glab repo'))

    await expect(getIssue('/repo-root', 1)).resolves.toBeNull()
  })

  it('updateIssue returns error when project ref cannot be resolved', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce(null)
    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toEqual({
      ok: false,
      error: 'Could not resolve GitLab project for this repository'
    })
  })
})
