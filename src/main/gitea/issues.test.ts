import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./repository-ref', () => ({
  getGiteaRepoRef: vi.fn(async () => ({
    host: 'git.example.com',
    owner: 'team',
    repo: 'app',
    apiBaseUrl: 'https://git.example.com/api/v1',
    webBaseUrl: 'https://git.example.com'
  }))
}))

vi.mock('./server-store', () => ({
  getServerForHost: () => ({
    server: {
      id: 'srv1',
      displayName: 'git.example.com',
      apiBaseUrl: 'https://git.example.com/api/v1',
      baseUrl: 'https://git.example.com',
      account: 'octo'
    },
    token: 'secret'
  })
}))

vi.mock('./request', () => ({
  encodedRepoPath: (repo: { owner: string; repo: string }) => `${repo.owner}/${repo.repo}`,
  giteaRepoGet: vi.fn(),
  giteaRepoWrite: vi.fn()
}))

import { getGiteaRepoRef } from './repository-ref'
import { giteaRepoGet, giteaRepoWrite } from './request'
import {
  addGiteaIssueComment,
  createGiteaIssue,
  getGiteaIssue,
  listGiteaWorkItems,
  updateGiteaIssue
} from './issues'

const getMock = vi.mocked(giteaRepoGet)
const writeMock = vi.mocked(giteaRepoWrite)
const repoRefMock = vi.mocked(getGiteaRepoRef)

beforeEach(() => {
  getMock.mockReset()
  writeMock.mockReset()
  repoRefMock.mockResolvedValue({
    host: 'git.example.com',
    owner: 'team',
    repo: 'app',
    apiBaseUrl: 'https://git.example.com/api/v1',
    webBaseUrl: 'https://git.example.com'
  })
})

describe('gitea issues', () => {
  it('lists open issues and pull requests as unified work items via the repo endpoint', async () => {
    getMock.mockResolvedValue([
      { id: 1, number: 1, title: 'Bug', state: 'open' },
      { id: 2, number: 2, title: 'A PR', state: 'closed', pull_request: { merged: true } }
    ])

    const items = await listGiteaWorkItems('/repo', 'all', 30, null)

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ number: 1, type: 'issue', state: 'open', serverId: 'srv1' })
    expect(items[1]).toMatchObject({ number: 2, type: 'pull', state: 'merged' })
    const [, path, options] = getMock.mock.calls[0]
    expect(path).toBe('/repos/team/app/issues')
    expect(options?.searchParams).toMatchObject({ state: 'open', limit: 30 })
    expect(options?.searchParams).not.toHaveProperty('type')
  })

  it('uses the global search endpoint for "assigned to me", scoped to the repo', async () => {
    getMock.mockResolvedValue([
      { id: 1, number: 1, title: 'Mine', state: 'open', repository: { full_name: 'team/app' } },
      { id: 9, number: 9, title: 'Other repo', state: 'open', repository: { full_name: 'team/x' } }
    ])

    const items = await listGiteaWorkItems('/repo', 'assigned', 10, null)

    // Cross-repo search hits are filtered back to the selected repo.
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ number: 1, title: 'Mine' })
    const [, path, options] = getMock.mock.calls[0]
    expect(path).toBe('/repos/issues/search')
    expect(options?.searchParams).toMatchObject({
      assigned: 'true',
      state: 'open',
      owner: 'team',
      limit: 10
    })
  })

  it('uses the global search endpoint with the created flag for "created by me"', async () => {
    getMock.mockResolvedValue([])
    await listGiteaWorkItems('/repo', 'created', 10, null)
    const [, path, options] = getMock.mock.calls[0]
    expect(path).toBe('/repos/issues/search')
    expect(options?.searchParams).toMatchObject({ created: 'true', owner: 'team' })
  })

  it('requests closed items from the repo endpoint for the closed filter', async () => {
    getMock.mockResolvedValue([])
    await listGiteaWorkItems('/repo', 'closed', 10, null)
    const [, path, options] = getMock.mock.calls[0]
    expect(path).toBe('/repos/team/app/issues')
    expect(options?.searchParams).toMatchObject({ state: 'closed' })
  })

  it('returns null for a single issue that is actually a PR', async () => {
    getMock.mockResolvedValue({ id: 9, number: 9, pull_request: {} })
    await expect(getGiteaIssue('/repo', 9, null)).resolves.toBeNull()
  })

  it('returns null when the repo is not a Gitea remote', async () => {
    repoRefMock.mockResolvedValue(null)
    await expect(getGiteaIssue('/repo', 9, null)).resolves.toBeNull()
  })

  it('creates an issue and returns its identifiers', async () => {
    writeMock.mockResolvedValue({
      ok: true,
      data: { id: 11, number: 5, html_url: 'https://git.example.com/team/app/issues/5' }
    })
    const result = await createGiteaIssue('/repo', { title: 'New', body: 'Body' }, null)
    expect(result).toEqual({
      ok: true,
      id: 11,
      number: 5,
      url: 'https://git.example.com/team/app/issues/5'
    })
    expect(writeMock.mock.calls[0][2]).toMatchObject({ method: 'POST' })
  })

  it('surfaces a create failure message', async () => {
    writeMock.mockResolvedValue({ ok: false, error: 'forbidden', status: 403 })
    await expect(createGiteaIssue('/repo', { title: 'New' }, null)).resolves.toEqual({
      ok: false,
      error: 'forbidden'
    })
  })

  it('patches issue fields and updates labels via the labels endpoint', async () => {
    writeMock.mockResolvedValue({ ok: true, data: {} })
    const result = await updateGiteaIssue('/repo', 5, { title: 'Renamed', labelIds: [1, 2] }, null)
    expect(result).toEqual({ ok: true })
    expect(writeMock).toHaveBeenCalledTimes(2)
    expect(writeMock.mock.calls[0][1]).toBe('/repos/team/app/issues/5')
    expect(writeMock.mock.calls[0][2]).toMatchObject({ method: 'PATCH' })
    expect(writeMock.mock.calls[1][1]).toBe('/repos/team/app/issues/5/labels')
    expect(writeMock.mock.calls[1][2]).toMatchObject({ method: 'PUT', body: { labels: [1, 2] } })
  })

  it('adds an issue comment', async () => {
    writeMock.mockResolvedValue({ ok: true, data: { id: 1 } })
    await expect(addGiteaIssueComment('/repo', 5, 'looks good', null)).resolves.toEqual({
      ok: true
    })
    expect(writeMock.mock.calls[0][1]).toBe('/repos/team/app/issues/5/comments')
  })
})
