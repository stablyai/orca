import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import type { RepoHostTarget } from '../shared/repo-host-identity'
import { closeTestStores, createStore, testState } from './persistence-test-harness'
import { wslMoveCutoverFixture as cutover } from './persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from './persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from './persistence/moving-wsl-projects/wsl-move-scope-guard'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'
import { RuntimeRepositoryForkBackfill } from './runtime/runtime-repository-fork-backfill'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./repo-git-remote-identity', () => ({ probeGitRemoteIdentity: vi.fn() }))
vi.mock('./github/client', () => ({
  getRepoUpstream: vi.fn(async () => ({ owner: 'acme', repo: 'app' }))
}))
vi.mock('./repo-icon-autodetect', () => ({ detectGitHubAvatarIcon: vi.fn(async () => null) }))

const MOVING = 'repo-1'
const STAYING = 'repo-2'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/ws/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-backfill-'))
  loadWslMoveFence(testState.dir)
  seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
    status: 'resolved',
    identity: { canonicalKey: 'github.com/acme/app', remoteName: 'origin', remoteUrl: 'u' }
  })
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  resetRepoGitRemoteIdentityEnrichmentForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('git remote identity enrichment under a WSL move', () => {
  it('skips only the moving local repo, and retries it once the move settles', async () => {
    const rows = [
      repo(MOVING),
      repo(STAYING),
      repo(MOVING, { connectionId: 'target-1', executionHostId: 'ssh:target-1' })
    ]
    const store = {
      getRepos: () => rows,
      updateRepo: (target: RepoHostTarget, updates: Partial<Repo>) => {
        const row = rows.find(
          (candidate) =>
            candidate.id === target.id &&
            getRepoExecutionHostId(candidate) === getRepoExecutionHostId(target)
        )
        return row ? Object.assign(row, updates) : null
      }
    }

    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()

    expect(rows.map((row) => row.gitRemoteIdentity?.canonicalKey)).toEqual([
      undefined,
      'github.com/acme/app',
      'github.com/acme/app'
    ])
    expect(probeGitRemoteIdentity).not.toHaveBeenCalledWith(
      '/ws/repo-1',
      'local',
      expect.anything()
    )

    resetWslMoveFenceForTests()
    enrichMissingRepoGitRemoteIdentities(store)
    await flushRepoGitRemoteIdentityEnrichmentForTests()
    expect(rows[0].gitRemoteIdentity?.canonicalKey).toBe('github.com/acme/app')
  })
})

describe('fork upstream backfill under a WSL move', () => {
  it('leaves the moving repo unset for a later run and fills the rest', async () => {
    const store = createStore()
    store.addRepo(repo(MOVING))
    store.addRepo(repo(STAYING))

    await new RuntimeRepositoryForkBackfill(() => store, vi.fn()).run()

    expect(store.getRepo(MOVING)?.upstream).toBeUndefined()
    expect(store.getRepo(STAYING)?.upstream).toEqual({ owner: 'acme', repo: 'app' })
  })

  it('fills the host row, not the hidden local row with the same id', async () => {
    seedWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
    const store = createStore()
    store.addRepo(repo(MOVING))
    store.addRepo(repo(MOVING, { executionHostId: 'runtime:env-1' }))

    await new RuntimeRepositoryForkBackfill(() => store, vi.fn()).run()

    const rows = store.getRepos().filter((row) => row.id === MOVING)
    expect(rows.map((row) => [getRepoExecutionHostId(row), row.upstream])).toEqual([
      ['local', undefined],
      ['runtime:env-1', { owner: 'acme', repo: 'app' }]
    ])
  })
})
