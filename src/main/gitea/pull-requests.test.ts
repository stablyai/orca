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

vi.mock('./request', () => ({
  encodedRepoPath: (repo: { owner: string; repo: string }) => `${repo.owner}/${repo.repo}`,
  giteaRepoGet: vi.fn(),
  giteaRepoGetText: vi.fn(),
  giteaRepoWrite: vi.fn()
}))

import { giteaRepoGet, giteaRepoGetText, giteaRepoWrite } from './request'
import {
  getGiteaPullRequestDetail,
  getGiteaPullRequestFileContents,
  listGiteaPullRequestFiles,
  mergeGiteaPullRequest
} from './pull-requests'

const getMock = vi.mocked(giteaRepoGet)
const textMock = vi.mocked(giteaRepoGetText)
const writeMock = vi.mocked(giteaRepoWrite)

beforeEach(() => {
  getMock.mockReset()
  textMock.mockReset()
  writeMock.mockReset()
})

describe('gitea pull requests', () => {
  it('maps PR detail including branches, shas, and merge state', async () => {
    getMock.mockResolvedValue({
      number: 7,
      title: 'Add feature',
      body: 'Body',
      state: 'open',
      html_url: 'https://git.example.com/team/app/pulls/7',
      user: { id: 1, login: 'octo' },
      head: { ref: 'feature', sha: 'head123' },
      base: { ref: 'main', sha: 'base456' },
      mergeable: true,
      merged: false,
      changed_files: 3,
      comments: 2,
      updated_at: '2026-01-02T00:00:00Z'
    })

    const detail = await getGiteaPullRequestDetail('/repo', 7, null)

    expect(detail).toMatchObject({
      number: 7,
      title: 'Add feature',
      state: 'open',
      headBranch: 'feature',
      baseBranch: 'main',
      headSha: 'head123',
      baseSha: 'base456',
      mergeable: true,
      merged: false,
      changedFiles: 3
    })
    expect(detail?.author).toMatchObject({ login: 'octo' })
  })

  it('maps changed files with normalized statuses', async () => {
    getMock.mockResolvedValue([
      { filename: 'a.ts', status: 'modified', additions: 4, deletions: 1 },
      { filename: 'b.ts', previous_filename: 'old.ts', status: 'renamed' },
      { filename: 'c.ts', status: 'weird' }
    ])

    const files = await listGiteaPullRequestFiles('/repo', 7, null)

    expect(files).toEqual([
      { path: 'a.ts', oldPath: undefined, status: 'modified', additions: 4, deletions: 1 },
      { path: 'b.ts', oldPath: 'old.ts', status: 'renamed', additions: 0, deletions: 0 },
      { path: 'c.ts', oldPath: undefined, status: 'changed', additions: 0, deletions: 0 }
    ])
    expect(getMock.mock.calls[0][1]).toBe('/repos/team/app/pulls/7/files')
  })

  it('fetches base and head content for a modified file', async () => {
    textMock.mockResolvedValueOnce('old contents').mockResolvedValueOnce('new contents')

    const contents = await getGiteaPullRequestFileContents(
      '/repo',
      { path: 'src/a.ts', status: 'modified', baseSha: 'base', headSha: 'head' },
      null
    )

    expect(contents).toEqual({
      original: 'old contents',
      modified: 'new contents',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    expect(textMock.mock.calls[0][2]?.searchParams).toMatchObject({ ref: 'base' })
    expect(textMock.mock.calls[1][2]?.searchParams).toMatchObject({ ref: 'head' })
  })

  it('skips the base fetch for added files', async () => {
    textMock.mockResolvedValue('new file')
    const contents = await getGiteaPullRequestFileContents(
      '/repo',
      { path: 'new.ts', status: 'added', baseSha: 'base', headSha: 'head' },
      null
    )
    expect(contents.original).toBe('')
    expect(contents.modified).toBe('new file')
    expect(textMock).toHaveBeenCalledTimes(1)
  })

  it('merges with the chosen method', async () => {
    writeMock.mockResolvedValue({ ok: true, data: {} })
    const result = await mergeGiteaPullRequest('/repo', 7, 'squash', null)
    expect(result).toEqual({ ok: true })
    expect(writeMock.mock.calls[0][1]).toBe('/repos/team/app/pulls/7/merge')
    expect(writeMock.mock.calls[0][2]).toMatchObject({ method: 'POST', body: { Do: 'squash' } })
  })
})
