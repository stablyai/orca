import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import type { StatsCollector } from '../../stats/collector'

const { handlers, getPRForBranch } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  getPRForBranch: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../../github/client/lookup/get-pr-for-branch', () => ({ getPRForBranch }))
vi.mock('../../github/pr-refresh-coordinator', () => ({
  addPRRefreshOutcomeObserver: vi.fn(),
  clearVisiblePRRefreshWindow: vi.fn(),
  enqueuePRRefresh: vi.fn(),
  refreshPRNow: vi.fn(),
  reportVisiblePRRefreshCandidates: vi.fn(),
  setPRRefreshRegistrationCheck: vi.fn()
}))
vi.mock('../../github/pr-refresh-renderer-port', () => ({ setPRRefreshRendererPort: vi.fn() }))
vi.mock('../../host/electron-pr-refresh-renderer', () => ({ electronPRRefreshRenderer: {} }))
vi.mock('../../workspaces/execution-host/project-runtime-git-options', () => ({
  getLocalProjectGhExecOptions: () => ({})
}))

import { registerGitHubPRRefreshHandlers } from './github-pr-refresh-handlers'
import { validateAutomaticPRRefreshCandidate } from './github-repo-routing'

const repo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only getRepos and getSettings.
const store = {
  getRepos: () => [repo],
  getProjects: () => [],
  getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
} as unknown as Store
const FRONTEND = { owner: 'relayto', repo: 'relayto-frontend' }

beforeEach(() => {
  handlers.clear()
  getPRForBranch.mockReset().mockResolvedValue(null)
})

describe('linked PR repositories at the GitHub IPC boundary', () => {
  it('keeps string-shaped repositories for the lookup to vet and drops everything else', () => {
    const forwarded = [
      { ...FRONTEND, token: 'x' },
      { owner: 'not an owner', repo: 'x' },
      'relayto/relayto-frontend'
    ].map((linkedPRRepository) => {
      const candidate: GitHubPRRefreshCandidate = {
        cacheKey: '/workspace/repo::feature',
        repoPath: repo.path,
        repoId: repo.id,
        branch: 'feature',
        repoKind: 'git',
        linkedPRNumber: 2383,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: renderer input is untrusted; this sends shapes the type forbids.
        linkedPRRepository: linkedPRRepository as GitHubPRRefreshCandidate['linkedPRRepository']
      }
      const result = validateAutomaticPRRefreshCandidate(candidate, store)
      return result.kind === 'ok' ? result.candidate.linkedPRRepository : 'skipped'
    })

    // The lookup refuses the malformed owner instead of reading this repository's #2383.
    expect(forwarded).toEqual([FRONTEND, { owner: 'not an owner', repo: 'x' }, undefined])
  })

  it('hands the linked repository to the direct PR lookup', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only hasCountedPR and record.
    const stats = { hasCountedPR: () => false, record: vi.fn() } as unknown as StatsCollector
    registerGitHubPRRefreshHandlers(store, stats, {
      notifyPullRequestChangedForRemoteClients: vi.fn()
    })

    await handlers.get('gh:prForBranch')?.(null, {
      repoPath: repo.path,
      repoId: repo.id,
      branch: 'feature',
      linkedPRNumber: 2383,
      linkedPRRepository: FRONTEND
    })

    expect(getPRForBranch).toHaveBeenCalledWith(
      repo.path,
      'feature',
      2383,
      null,
      null,
      expect.objectContaining({ linkedPRRepository: FRONTEND })
    )
  })
})
