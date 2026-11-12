import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/hosted-cli/gh-exec-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ghExecFileAsync: clientMocks.ghExecFileAsyncMock
}))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getFallbackPRListForBranch, getRestPRForBranch } from './client/lookup/pr-branch-lookup'

import { resetPRForBranchMocks } from './client-test-harness'

const { ghExecFileAsyncMock } = clientMocks

describe('PR lookup conditional REST reads', () => {
  beforeEach(() => resetPRForBranchMocks(clientMocks))

  it('revalidates both mixed and active discovery responses before falling back to history', async () => {
    const repo = { owner: 'acme', repo: 'widgets', host: 'github.com' }
    const old = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1,
      state: 'closed',
      title: 'Old',
      head: { ref: 'feature' }
    }))
    const open = { number: 11, state: 'open', title: 'Active', head: { ref: 'feature' } }
    const http = (data: unknown, etag: string) => ({
      stdout: `HTTP/2.0 200 OK\nEtag: "${etag}"\r\n\r\n${JSON.stringify(data)}`
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce(http(old, 'recent'))
      .mockResolvedValueOnce(http([open], 'active'))
      .mockRejectedValueOnce(
        Object.assign(new Error('304'), { stdout: 'HTTP/2.0 304 Not Modified\n\n' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('304'), { stdout: 'HTTP/2.0 304 Not Modified\n\n' })
      )
    await expect(
      getRestPRForBranch(repo, 'acme', 'feature', { cwd: '/repo' })
    ).resolves.toMatchObject({ number: 11 })
    await expect(
      getRestPRForBranch(repo, 'acme', 'feature', { cwd: '/repo' })
    ).resolves.toMatchObject({ number: 11 })
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toContain('If-None-Match: "recent"')
    expect(ghExecFileAsyncMock.mock.calls[3][0]).toContain('If-None-Match: "active"')
  })
  it('uses the same saturated-page rule for the CLI fallback', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify(
          Array.from({ length: 10 }, (_, i) => ({ number: i + 1, state: 'CLOSED' }))
        )
      })
      .mockResolvedValueOnce({ stdout: '[{"number":11,"state":"OPEN"}]' })
    await expect(
      getFallbackPRListForBranch(
        { owner: 'acme', repo: 'widgets', host: 'github.com' },
        'feature',
        { cwd: '/repo' }
      )
    ).resolves.toMatchObject({ number: 11 })
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['--state', 'all', '--limit', '10'])
    )
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toEqual(
      expect.arrayContaining(['--state', 'open', '--limit', '1'])
    )
  })
})
