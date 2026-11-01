import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveGiteaIssueSourceMock, requestGiteaJsonMock, teaExecFileAsyncMock } = vi.hoisted(
  () => ({
    resolveGiteaIssueSourceMock: vi.fn(),
    requestGiteaJsonMock: vi.fn(),
    teaExecFileAsyncMock: vi.fn()
  })
)

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./gitea-json-request', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  configuredGiteaApiBaseUrl: (repo: { apiBaseUrl: string }) => repo.apiBaseUrl
}))

vi.mock('../git/runner', () => ({
  teaExecFileAsync: teaExecFileAsyncMock
}))

import { updateGiteaIssue } from './issue-update'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

const OLD_ENV = process.env

describe('updateGiteaIssue', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    requestGiteaJsonMock.mockReset()
    requestGiteaJsonMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path.endsWith('/labels')) {
        return [
          { id: 3, name: 'bug' },
          { id: 4, name: 'wip' }
        ]
      }
      return {
        assignees: [{ login: 'ada' }, { username: 'grace' }]
      }
    })
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  it('closes and reopens through tea issues without entering edit', async () => {
    await expect(updateGiteaIssue('/repo', 12, { state: 'closed' }, 'upstream')).resolves.toEqual({
      ok: true
    })
    await expect(updateGiteaIssue('/repo', 12, { state: 'open' })).resolves.toEqual({ ok: true })

    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['issues', 'close', '12', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['issues', 'reopen', '12', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
    expect(teaExecFileAsyncMock.mock.calls.map((call) => call[0][1])).not.toContain('edit')
    expect(resolveGiteaIssueSourceMock).toHaveBeenCalledWith('/repo', 'upstream', null, {})
  })

  it('edits title, description, labels, and assignees in one tea issues edit', async () => {
    await expect(
      updateGiteaIssue(
        '/repo',
        12,
        {
          title: '  Renamed  ',
          body: 'Updated body',
          addLabels: ['bug', '  '],
          removeLabels: ['wip'],
          addAssignees: ['carol'],
          removeAssignees: ['ada']
        },
        'origin',
        'conn-1',
        { host: 'git.example.com', path: 'fork/widgets' },
        { wslDistro: 'Ubuntu' }
      )
    ).resolves.toEqual({ ok: true })

    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'issues',
        'edit',
        '12',
        '--title',
        'Renamed',
        '--description',
        'Updated body',
        '--add-labels',
        'bug',
        '--remove-labels',
        'wip',
        '--add-assignees',
        'carol',
        '--remove-assignees',
        'ada',
        '--repo',
        'fork/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false, cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })

  it('does not invoke tea issues edit when no edit flags are present', async () => {
    await expect(
      updateGiteaIssue('/repo', 12, {
        addLabels: ['  '],
        removeLabels: [],
        addAssignees: [],
        removeAssignees: ['']
      })
    ).resolves.toEqual({ ok: true })
    await expect(updateGiteaIssue('/repo', 12, {})).resolves.toEqual({ ok: true })

    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('closes and then edits when state and description are both set', async () => {
    await expect(updateGiteaIssue('/repo', 12, { state: 'closed', body: 'Done' })).resolves.toEqual(
      { ok: true }
    )

    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['issues', 'close', '12', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false })
    )
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'issues',
        'edit',
        '12',
        '--description',
        'Done',
        '--repo',
        'team/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false })
    )
  })

  it('patches state and body over HTTP and applies label changes without tea', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      updateGiteaIssue('/repo', 12, {
        state: 'closed',
        body: 'Updated body',
        addLabels: ['bug'],
        removeLabels: ['wip'],
        addAssignees: ['carol'],
        removeAssignees: ['ada']
      })
    ).resolves.toEqual({ ok: true })

    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    const patch = fetchMock.mock.calls.find((call) => call[1]?.method === 'PATCH')
    expect(String(patch?.[0])).toBe('https://git.example.com/api/v1/repos/team/widgets/issues/12')
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      state: 'closed',
      body: 'Updated body',
      assignees: ['grace', 'carol']
    })
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/labels/4'))).toBe(true)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/issues/12/labels'))).toBe(
      true
    )
  })
})
