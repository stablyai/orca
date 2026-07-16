/**
 * Issue #8935 — GitHub Enterprise PR work item diffs do not load.
 *
 * Root cause chain:
 * 1. `parseGitHubOwnerRepo` only accepts github.com → null for GHE remotes
 * 2. `getPRFiles` / `getPRFileContents` / work-item detail PR path use `getOwnerRepo`
 *    (not `getEnterpriseGitHubRepoSlug`) and return null / empty when owner is unresolved
 * 3. `gh api` calls never pass `--hostname <enterprise-host>`, so even a forced
 *    owner/repo slug would still hit github.com by default
 *
 * Related fix PR: https://github.com/stablyai/orca/pull/8932
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/github/repro-8935-ghe-pr-diff-host.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getWorkItemMock,
  getPRChecksMock,
  getPRCommentsMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  ghRepoExecOptionsMock,
  githubRepoContextMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRChecksMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false as const })),
  noteRateLimitSpendMock: vi.fn(),
  ghRepoExecOptionsMock: vi.fn((context) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) }
  ),
  githubRepoContextMock: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  ghRepoExecOptions: ghRepoExecOptionsMock,
  githubRepoContext: githubRepoContextMock,
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRChecks: getPRChecksMock,
  getPRComments: getPRCommentsMock
}))

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import { getPRFileContents, getWorkItemDetails } from './work-item-details'
import { parseGitHubOwnerRepo, parseGitHubRemoteIdentity } from './github-remote-identity-parsing'

describe('issue #8935 GHE PR diff host routing', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getWorkItemMock.mockReset()
    getPRChecksMock.mockReset()
    getPRCommentsMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('parseGitHubOwnerRepo returns null for Enterprise remotes (github.com only)', () => {
    expect(parseGitHubOwnerRepo('https://github.acme-corp.com/team/orca.git')).toBeNull()
    expect(parseGitHubOwnerRepo('git@github.acme-corp.com:team/orca.git')).toBeNull()
    expect(parseGitHubOwnerRepo('https://ghe.acme.internal/acme/widgets.git')).toBeNull()

    // Identity parser still sees host+owner+repo — data is available, just not used by getOwnerRepo
    expect(parseGitHubRemoteIdentity('https://github.acme-corp.com/team/orca.git')).toEqual({
      host: 'github.acme-corp.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('getWorkItemDetails marks filesUnavailable when getOwnerRepo is null (GHE path)', async () => {
    getWorkItemMock.mockResolvedValueOnce({
      id: 'pr:7',
      type: 'pr',
      number: 7,
      title: 'Enterprise PR',
      state: 'open',
      url: 'https://github.acme-corp.com/team/orca/pull/7',
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: 'pr-author'
    })
    // Why: mirrors parseGitHubOwnerRepo null for non-github.com origin remotes.
    getOwnerRepoMock.mockResolvedValue(null)
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockResolvedValue([])
    // Fallback paths may still call gh (pr view / etc.) without --hostname.
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ body: 'meta only', headRefOid: 'h', baseRefOid: 'b' })
    })

    const details = await getWorkItemDetails('/repo-root', 7, 'pr')

    expect(details).not.toBeNull()
    expect(details?.filesUnavailable).toBe(true)
    expect(details?.files).toBeUndefined()

    const apiCalls = ghExecFileAsyncMock.mock.calls.map(([args]) => args as string[])
    // Bug: no Enterprise host routing on this path today.
    expect(apiCalls.every((args) => !args.includes('--hostname'))).toBe(true)
  })

  it('getPRFileContents returns empty when getOwnerRepo is null (cannot load GHE file content)', async () => {
    getOwnerRepoMock.mockResolvedValue(null)

    const contents = await getPRFileContents({
      repoPath: '/repo-root',
      prNumber: 7,
      path: 'src/main.ts',
      status: 'modified',
      headSha: 'head-sha',
      baseSha: 'base-sha'
    })

    expect(contents).toEqual({
      original: '',
      modified: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('work-item-details source uses getOwnerRepo and never getEnterpriseGitHubRepoSlug / --hostname', () => {
    const source = readFileSync(join(__dirname, 'work-item-details.ts'), 'utf8')
    expect(source).toContain('getOwnerRepo')
    expect(source).not.toContain('getEnterpriseGitHubRepoSlug')
    expect(source).not.toContain('--hostname')
  })
})
