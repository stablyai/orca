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

  it('recovers issue 7704 oversized inline-image creation', async () => {
    const imagePrefix = 'data:image/png;base64,'
    const body = imagePrefix + 'x'.repeat(133596 - imagePrefix.length)
    expect(body).toContain('data:image')
    expect(body).toHaveLength(133596)

    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 422: body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 926,
          html_url: 'https://github.com/stablyai/orca/issues/926'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(
      createIssue('/repo-root', 'Image issue', body, undefined, undefined, {
        labels: ['bug'],
        assignees: ['octo']
      })
    ).resolves.toEqual({
      ok: true,
      number: 926,
      url: 'https://github.com/stablyai/orca/issues/926'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        `body=${body}`,
        'title=Image issue',
        'labels[]=bug',
        'assignees[]=octo'
      ]),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['body=', 'title=Image issue', 'labels[]=bug', 'assignees[]=octo']),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '-X', 'PATCH', 'repos/stablyai/orca/issues/926', '--raw-field', `body=${body}`],
      { cwd: '/repo-root' }
    )
  })

  it('recognizes the oversized-body response from structured gh stderr', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh'), {
          stderr: 'gh: body is too long (maximum is 65536 characters) (HTTP 422)'
        })
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 929,
          html_url: 'https://github.com/stablyai/orca/issues/929'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(createIssue('/repo-root', 'Image issue', 'data:image')).resolves.toEqual({
      ok: true,
      number: 929,
      url: 'https://github.com/stablyai/orca/issues/929'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry unrelated create failures', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: assignees is invalid'))

    await expect(createIssue('/repo-root', 'Invalid issue', 'Body')).resolves.toEqual({
      ok: false,
      error: 'HTTP 422: assignees is invalid'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('stops when placeholder create fails during oversized-body recovery', async () => {
    const body = `data:image/png;base64,${'x'.repeat(100)}`
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockRejectedValueOnce(new Error('HTTP 500: create failed'))

    await expect(createIssue('/repo-root', 'Placeholder failure', body)).resolves.toEqual({
      ok: false,
      error: 'HTTP 500: create failed'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('preserves fields during oversized-body recovery', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const body = `data:image/png;base64,${'x'.repeat(100)}`
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ number: 927, url: 'issue-url' }) })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(
      createIssue(
        '/repo-root',
        'Fields issue',
        body,
        undefined,
        null,
        {
          labels: ['bug'],
          assignees: ['octo']
        },
        localGitOptions
      )
    ).resolves.toEqual({ ok: true, number: 927, url: 'issue-url' })
    const firstCreateArgs = [...ghExecFileAsyncMock.mock.calls[0][0]]
    const fallbackCreateArgs = [...ghExecFileAsyncMock.mock.calls[1][0]]
    firstCreateArgs[firstCreateArgs.indexOf(`body=${body}`)] = 'body='
    expect(fallbackCreateArgs).toEqual(firstCreateArgs)
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo-root',
      undefined,
      null,
      localGitOptions
    )
  })

  it('reports partial success when oversized-body patch fails', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 928,
          html_url: 'https://github.com/stablyai/orca/issues/928'
        })
      })
      .mockRejectedValueOnce(new Error('HTTP 500: update failed'))

    await expect(createIssue('/repo-root', 'Partial issue', 'data:image')).resolves.toEqual({
      ok: true,
      number: 928,
      url: 'https://github.com/stablyai/orca/issues/928',
      bodySaveWarning:
        'Issue https://github.com/stablyai/orca/issues/928 was created, but saving its body failed: HTTP 500: update failed'
    })
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

  it('closes issues with completed, not planned, and duplicate reasons', async () => {
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 924, { state: 'closed', stateReason: 'completed' })
    ).resolves.toEqual({ ok: true })
    await expect(
      updateIssue('/repo-root', 925, { state: 'closed', stateReason: 'not_planned' })
    ).resolves.toEqual({ ok: true })
    await expect(
      updateIssue('/repo-root', 926, {
        state: 'closed',
        stateReason: 'duplicate',
        duplicateOf: 99
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['issue', 'close', '924', '--repo', 'stablyai/orca', '--reason', 'completed'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['issue', 'close', '925', '--repo', 'stablyai/orca', '--reason', 'not planned'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['issue', 'close', '926', '--repo', 'stablyai/orca', '--duplicate-of', '99'],
      { cwd: '/repo-root' }
    )
  })

  it('reopens issues through gh issue reopen', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 924, { state: 'open' })).resolves.toEqual({
      ok: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'reopen', '924', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root' }
    )
  })
})
