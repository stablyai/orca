import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveGiteaIssueSourceMock, requestGiteaJsonMock, invalidateMock, teaExecFileAsyncMock } =
  vi.hoisted(() => ({
    resolveGiteaIssueSourceMock: vi.fn(),
    requestGiteaJsonMock: vi.fn(),
    invalidateMock: vi.fn(),
    teaExecFileAsyncMock: vi.fn()
  }))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./gitea-json-request', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  configuredGiteaApiBaseUrl: (repo: { apiBaseUrl: string }) => repo.apiBaseUrl
}))

vi.mock('./client', () => ({
  invalidateGiteaPullRequestScanForRepo: invalidateMock
}))

vi.mock('../git/runner', () => ({
  teaExecFileAsync: teaExecFileAsyncMock
}))

import { updateGiteaPR, updateGiteaPRReviewers } from './pull-request-update'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

const OLD_ENV = process.env

function currentPull() {
  return {
    title: 'WIP: Ship it',
    state: 'open',
    requested_reviewers: [{ login: 'alice' }, { username: 'bob' }]
  }
}

describe('Gitea pull request metadata updates', () => {
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
      return currentPull()
    })
    invalidateMock.mockReset()
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  it('edits title, description, and labels through tea pr edit', async () => {
    await expect(
      updateGiteaPR('/repo', 4, {
        title: 'Ship it',
        body: 'Details',
        addLabels: ['bug'],
        removeLabels: ['wip']
      })
    ).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'edit',
        '4',
        '--title',
        'Ship it',
        '--description',
        'Details',
        '--add-labels',
        'bug',
        '--remove-labels',
        'wip',
        '--repo',
        'team/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
    expect(invalidateMock).toHaveBeenCalledWith(repo)
  })

  it('strips a draft prefix and passes --ready when marking a pull request ready', async () => {
    await expect(updateGiteaPR('/repo', 4, { draft: false })).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'edit',
        '4',
        '--title',
        'Ship it',
        '--ready',
        '--repo',
        'team/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false })
    )
  })

  it('strips a Draft: prefix over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    requestGiteaJsonMock.mockResolvedValue({ title: 'Draft: Ship it', state: 'open' })
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateGiteaPR('/repo', 4, { draft: false })).resolves.toEqual({ ok: true })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ title: 'Ship it' })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('adds and removes reviewer usernames as a delta', async () => {
    await expect(updateGiteaPRReviewers('/repo', 4, ['bob', 'carol'])).resolves.toEqual({
      ok: true,
      reviewers: ['bob', 'carol']
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'edit',
        '4',
        '--add-reviewers',
        'carol',
        '--remove-reviewers',
        'alice',
        '--repo',
        'team/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false })
    )
    expect(invalidateMock).toHaveBeenCalledWith(repo)
  })

  it('skips tea when the requested reviewers already match', async () => {
    await expect(updateGiteaPRReviewers('/repo', 4, ['Alice', 'bob'])).resolves.toEqual({
      ok: true,
      reviewers: ['Alice', 'bob']
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('posts and deletes requested reviewers over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(updateGiteaPRReviewers('/repo', 4, ['carol'])).resolves.toEqual({
      ok: true,
      reviewers: ['carol']
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = fetchMock.mock.calls[0]?.[1]
    const second = fetchMock.mock.calls[1]?.[1]
    expect(first?.method).toBe('DELETE')
    expect(JSON.parse(String(first?.body))).toEqual({ reviewers: ['alice', 'bob'] })
    expect(second?.method).toBe('POST')
    expect(JSON.parse(String(second?.body))).toEqual({ reviewers: ['carol'] })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
