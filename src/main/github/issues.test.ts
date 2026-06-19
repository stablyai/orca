import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhUtils from './gh-utils'

const {
  ghExecFileAsyncMock,
  getIssueOwnerRepoMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

import {
  addIssueComment,
  createIssue,
  getIssue,
  listAssignableUsers,
  listIssues,
  listLabels,
  updateIssue
} from './issues'

describe('issue source operations', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    resolveIssueSourceMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Why: preference-aware paths call resolveIssueSource instead of
    // getIssueOwnerRepo. Route through the same mock so existing tests that
    // set up getIssueOwnerRepoMock continue to work.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
  })

  it('gets a single issue from the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 923,
        title: 'Use upstream issues',
        state: 'open',
        html_url: 'https://github.com/stablyai/orca/issues/923',
        labels: []
      })
    })

    await expect(getIssue('/repo-root', 923)).resolves.toMatchObject({ number: 923 })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/stablyai/orca/issues/923'],
      { cwd: '/repo-root' }
    )
  })

  it('routes local WSL issue operations through repo resolution and gh execution options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    resolveIssueSourceMock.mockResolvedValue({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 923,
          title: 'Use upstream issues',
          state: 'open',
          html_url: 'https://github.com/stablyai/orca/issues/923',
          labels: []
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 924,
          html_url: 'https://github.com/stablyai/orca/issues/924'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 1,
          user: { login: 'octo', avatar_url: '', type: 'User' },
          body: 'Comment',
          created_at: '2026-06-16T00:00:00.000Z',
          html_url: 'https://github.com/stablyai/orca/issues/923#issuecomment-1'
        })
      })
      .mockResolvedValueOnce({ stdout: 'bug\nfrontend\n' })
      .mockResolvedValueOnce({ stdout: '{"login":"octo","avatar_url":""}\n' })

    await getIssue('/repo-root', 923, null, localGitOptions)
    await listIssues('/repo-root', 5, undefined, null, localGitOptions)
    await createIssue(
      '/repo-root',
      'New issue',
      'Body',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    await updateIssue('/repo-root', 923, { body: 'Updated' }, null, localGitOptions)
    await addIssueComment('/repo-root', 923, 'Comment', null, null, localGitOptions)
    await listLabels('/repo-root', undefined, null, localGitOptions)
    await listAssignableUsers('/repo-root', undefined, null, localGitOptions)

    expect(getIssueOwnerRepoMock).toHaveBeenCalledWith('/repo-root', null, localGitOptions)
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo-root',
      undefined,
      null,
      localGitOptions
    )
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })

  it('lists issues from the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await expect(listIssues('/repo-root', 5)).resolves.toEqual({ items: [] })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--cache',
        '120s',
        'repos/stablyai/orca/issues?per_page=5&state=open&sort=updated&direction=desc'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('surfaces a classified permission_denied error instead of collapsing to empty', async () => {
    // Why: parent design doc §3 — a 403 on a private upstream must not
    // masquerade as "No issues". The envelope carries an error the UI can
    // render as a banner with retry, not a silent empty list.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(
      new Error('HTTP 403: Resource not accessible by integration')
    )

    const result = await listIssues('/repo-root', 5)

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('permission_denied')
  })

  it('creates issues in the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 924,
        html_url: 'https://github.com/stablyai/orca/issues/924'
      })
    })

    await expect(createIssue('/repo-root', 'New issue', 'Body')).resolves.toEqual({
      ok: true,
      number: 924,
      url: 'https://github.com/stablyai/orca/issues/924'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'repos/stablyai/orca/issues',
        '--raw-field',
        'title=New issue',
        '--raw-field',
        'body=Body'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('creates issues with labels and assignees', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 925,
        html_url: 'https://github.com/stablyai/orca/issues/925'
      })
    })

    await expect(
      createIssue('/repo-root', 'New issue', 'Body', undefined, undefined, {
        labels: ['bug', 'frontend'],
        assignees: ['octo']
      })
    ).resolves.toEqual({
      ok: true,
      number: 925,
      url: 'https://github.com/stablyai/orca/issues/925'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'repos/stablyai/orca/issues',
        '--raw-field',
        'title=New issue',
        '--raw-field',
        'body=Body',
        '--raw-field',
        'labels[]=bug',
        '--raw-field',
        'labels[]=frontend',
        '--raw-field',
        'assignees[]=octo'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('updates issue body through the REST issue endpoint', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 924, { body: 'Updated body' })).resolves.toEqual({
      ok: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '-X', 'PATCH', 'repos/stablyai/orca/issues/924', '--raw-field', 'body=Updated body'],
      { cwd: '/repo-root' }
    )
  })
})
