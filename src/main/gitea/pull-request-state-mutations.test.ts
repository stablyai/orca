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

import { closeGiteaPR, mergeGiteaPR, reopenGiteaPR } from './pull-request-state-mutations'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

const OLD_ENV = process.env

describe('Gitea pull request state mutations', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    requestGiteaJsonMock.mockReset()
    requestGiteaJsonMock.mockResolvedValue({ state: 'open', merged: false })
    invalidateMock.mockReset()
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  it('closes an open pull request with an explicit tea index, repo, and login', async () => {
    await expect(closeGiteaPR('/repo', 12)).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'close', '12', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
    expect(invalidateMock).toHaveBeenCalledWith(repo)
  })

  it('reopens a closed pull request with tea pr reopen', async () => {
    requestGiteaJsonMock.mockResolvedValue({ state: 'closed', merged: false })

    await expect(reopenGiteaPR('/repo', 12)).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'reopen', '12', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false })
    )
  })

  it('merges with an explicit style so tea does not prompt', async () => {
    await expect(mergeGiteaPR('/repo', 12, 'squash')).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'merge', '12', '--style', 'squash', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, timeout: 60_000 })
    )
    expect(invalidateMock).toHaveBeenCalledWith(repo)
  })

  it('rejects a missing pull index before invoking tea', async () => {
    await expect(closeGiteaPR('/repo', 0)).resolves.toEqual({
      ok: false,
      error: 'Pull request index must be a positive integer.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('treats an already-closed pull request as success without another write', async () => {
    requestGiteaJsonMock.mockResolvedValue({ state: 'closed', merged: false })

    await expect(closeGiteaPR('/repo', 12)).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('surfaces an error when closing or merging an already-merged pull request', async () => {
    requestGiteaJsonMock.mockResolvedValue({ state: 'closed', merged: true })

    await expect(closeGiteaPR('/repo', 12)).resolves.toEqual({
      ok: false,
      error: 'Pull request is already merged.'
    })
    await expect(mergeGiteaPR('/repo', 12, 'rebase-merge')).resolves.toEqual({
      ok: false,
      error: 'Pull request is already merged.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps a merged-state failure from tea instead of treating it as already closed', async () => {
    teaExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('close failed'), { stderr: 'pull request has already been merged' })
    )

    await expect(closeGiteaPR('/repo', 12)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('pull request has already been merged')
    })
    expect(invalidateMock).toHaveBeenCalledWith(repo)
  })

  it('patches pull request state over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('PATCH')
      expect(JSON.parse(String(init?.body))).toEqual({ state: 'closed' })
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(closeGiteaPR('/repo', 12)).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/pulls/12'
    )
    expect(invalidateMock).toHaveBeenCalledWith(repo)
  })

  it('posts the merge style over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(mergeGiteaPR('/repo', 8, 'rebase')).resolves.toEqual({ ok: true })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ Do: 'rebase' })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/pulls/8/merge')
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
