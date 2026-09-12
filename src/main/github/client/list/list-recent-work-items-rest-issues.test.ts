import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('../../gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  classifyGhError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListIssuesError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  classifyListPrsError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  ghRepoExecOptions: (context: {
    repoPath: string
    connectionId?: string | null
    wslDistro?: string
  }) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) },
  githubRepoContext: (
    repoPath: string,
    connectionId?: string | null,
    localGitOptions: { wslDistro?: string } = {}
  ) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }),
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../../github-api-repository', () => ({
  githubHostExecOptions: () => ({})
}))

vi.mock('../detect/hydrate-work-item-merge-metadata', () => ({
  hydrateWorkItemRepositoryMergeMetadata: async (prs: unknown[]) => prs
}))

vi.mock('../github-exec-scope', () => ({
  githubPRStackExecutionScope: () => undefined
}))

import { buildRecentIssueListRequest } from './work-item-list-request'
import { listRecentWorkItems } from './work-item-pages'

describe('buildRecentIssueListRequest', () => {
  it('targets the REST repo-issues listing instead of the Search API', () => {
    const request = buildRecentIssueListRequest({ ownerRepo: { owner: 'acme', repo: 'widgets' }, limit: 24, page: 1 })
    expect(request.offset).toBe(0)
    expect(request.args[0]).toBe('api')
    expect(request.args[3]).toBe(
      'repos/acme/widgets/issues?per_page=24&page=1&state=open&sort=created&direction=desc'
    )
    expect(request.args.join(' ')).not.toContain('search/issues')
  })

  it('keeps the --cache flags at indices 1..2 so the noCache splice keeps working', () => {
    const request = buildRecentIssueListRequest({ ownerRepo: { owner: 'a', repo: 'b' }, limit: 5, page: 2 })
    expect(request.args.slice(1, 3)).toEqual(['--cache', '120s'])
  })
})

describe('listRecentWorkItems issue-side source', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    acquireMock.mockReset().mockResolvedValue(undefined)
    releaseMock.mockReset()
  })

  it('queries the REST issues endpoint for the default listing', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { number: 7, title: 'Broken thing', state: 'open', html_url: 'https://x/7' }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    const result = await listRecentWorkItems(
      '/repo-root',
      { owner: 'acme', repo: 'widgets' },
      { owner: 'acme', repo: 'widgets' },
      24,
      1
    )

    expect(ghExecFileAsyncMock.mock.calls[0][0][0]).toContain('repos/acme/widgets/issues?')
    expect(result.items.map((item) => item.id)).toEqual(['issue:7'])
  })

  it('surfaces a classified error when the account cannot see the repo instead of reading as empty', async () => {
    const failure = Object.assign(new Error('gh: HTTP 404'), { stderr: 'gh: HTTP 404' })
    ghExecFileAsyncMock.mockRejectedValueOnce(failure).mockResolvedValueOnce({ stdout: '[]' })

    const result = await listRecentWorkItems(
      '/repo-root',
      { owner: 'acme', repo: 'private-widgets' },
      { owner: 'acme', repo: 'private-widgets' },
      24,
      1
    )

    expect(result.issuesError).toEqual({ type: 'unknown', message: 'gh: HTTP 404' })
  })
})
