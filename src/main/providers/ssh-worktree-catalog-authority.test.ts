/**
 * Issue #14004: an SSH worktree catalog Orca could not read must never surface as an authoritative
 * empty catalog. Covers the whole client-side chain — provider response guard, the repo-level
 * listing, and the detected-worktree result whose `authoritative` flag gates renderer terminal
 * teardown (`teardownMissingWorktreeTerminalsBestEffort`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'
import { isWorktreeCatalogUnavailableError } from '../../shared/worktree/worktree-catalog-availability'
import { listRepoWorktrees } from '../repo-worktrees'
import { listDetectedWorktreesForCapturedRepo } from '../ipc/worktrees/listing/detected-provider-listing'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence/loading-store/store'

const { getSshGitProviderMock } = vi.hoisted(() => ({ getSshGitProviderMock: vi.fn() }))

vi.mock('./ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  requireSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: () => 1
}))

const CONNECTION_ID = 'conn-1'
const REPO_PATH = '/home/user/repo'
const WORKTREE_PATH = '/home/user/feature'

const repo: Repo = {
  id: 'repo-1',
  path: REPO_PATH,
  displayName: 'repo',
  connectionId: CONNECTION_ID
} as Repo

const worktreeId = `${repo.id}::${WORKTREE_PATH}`

function createStore(): Store {
  const meta: Record<string, { hostId?: string; instanceId?: string }> = {
    [worktreeId]: { instanceId: 'instance-1' }
  }
  return {
    getRepos: () => [repo],
    getRepo: () => repo,
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: vi.fn(),
    getAllWorktreeLineage: () => ({}),
    getProjectHostSetups: () => [],
    getSettings: () => ({})
  } as unknown as Store
}

describe('SSH worktree catalog authority (#14004)', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider(CONNECTION_ID, mux as never)
    getSshGitProviderMock.mockReset()
    getSshGitProviderMock.mockReturnValue(provider)
  })

  it('refuses an empty relay response instead of publishing an empty catalog', async () => {
    // An older relay converted a failed `git worktree list` into `[]`; mixed versions are the normal state.
    mux.request.mockResolvedValue([])

    await expect(provider.listWorktrees(REPO_PATH)).rejects.toSatisfy(
      isWorktreeCatalogUnavailableError
    )
  })

  it('refuses a malformed relay response', async () => {
    mux.request.mockResolvedValue(undefined)

    await expect(provider.listWorktrees(REPO_PATH)).rejects.toSatisfy(
      isWorktreeCatalogUnavailableError
    )
  })

  it('reports an unreachable SSH host as unavailable, not as an empty repo listing', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)

    await expect(listRepoWorktrees(repo)).rejects.toSatisfy(isWorktreeCatalogUnavailableError)
  })

  it('does not authorize missing-worktree teardown when the relay listing fails', async () => {
    mux.request.mockRejectedValue(new Error('relay request failed'))

    const result = await listDetectedWorktreesForCapturedRepo(
      createStore(),
      repo,
      () => true,
      provider
    )

    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
    // The persisted workspace survives the failed scan, so the renderer has nothing to reconcile away.
    expect(
      (result as { worktrees: { id: string }[] }).worktrees.map((worktree) => worktree.id)
    ).toContain(worktreeId)
  })

  it('does not authorize missing-worktree teardown when the relay answers with an empty list', async () => {
    mux.request.mockResolvedValue([])

    const result = await listDetectedWorktreesForCapturedRepo(
      createStore(),
      repo,
      () => true,
      provider
    )

    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
    expect(
      (result as { worktrees: { id: string }[] }).worktrees.map((worktree) => worktree.id)
    ).toContain(worktreeId)
  })

  it('republishes an authoritative catalog once the relay answers again', async () => {
    mux.request.mockResolvedValue([
      { path: REPO_PATH, head: 'abc123', branch: 'main', isBare: false, isMainWorktree: true },
      {
        path: WORKTREE_PATH,
        head: 'def456',
        branch: 'feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await listDetectedWorktreesForCapturedRepo(
      createStore(),
      repo,
      () => true,
      provider
    )

    expect(result).toMatchObject({ authoritative: true, source: 'git' })
  })
})
