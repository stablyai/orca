import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  testState
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'
import type { SshTarget } from '../shared/ssh-types'
import { MAX_RETIREMENT_NAMESPACES } from './worktree-retirement-namespace'
import { getRuntimeOwnedSshTargetId } from './ssh/connection/ssh-connection-store'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { resetRetirementCollisionKeyCacheForTests } from './worktree-name-retirement'

let hasCreatedStoreInCase = false

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const REPO = 'repo-1'
const OTHER_REPO = 'repo-2'
const POOL = MARINE_CREATURES.map((name) => name.toLowerCase())

const REMOTE_REPO = {
  id: REPO,
  path: '/remote/repos/a',
  displayName: 'a',
  badgeColor: '',
  addedAt: 0
}

function sshTarget(id: string, overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id,
    label: 'builder',
    host: 'builder.example.com',
    port: 22,
    username: 'dev',
    source: 'manual',
    ...overrides
  }
}

async function reloadStore() {
  vi.resetModules()
  const { Store, initDataPath } = await import('./persistence')
  // Reinstall this test’s userData path after resetModules before initializing Store.
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

async function createStore(persisted: Record<string, unknown> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), ...persisted }),
    'utf-8'
  )
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  return reloadStore()
}

beforeEach(() => {
  hasCreatedStoreInCase = false
  resetRetirementCollisionKeyCacheForTests()
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-name-retirement-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { force: true, recursive: true })
})

describe('worktree name retirement registry', () => {
  it('retains a retired name so it is never reissued', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'Nautilus')
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])
  })

  it('scopes retirement per repo so one repo does not burn another pool', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'nautilus')
    expect(store.getRetiredWorktreeNameRegistry(OTHER_REPO).names).toEqual([])
  })

  it('normalizes case and whitespace so a name cannot be retired twice', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, '  NaUtIlUs ')
    store.addRetiredWorktreeName(REPO, 'nautilus')
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])
  })

  it('ignores an empty name or missing repo id', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, '   ')
    store.addRetiredWorktreeName('', 'nautilus')
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual([])
  })

  it('does not persist arbitrary user and issue-title names', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'fix-login-redirect')
    store.addRetiredWorktreeName(REPO, 'STA-4189-duplicate-name')
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual([])
  })

  it('returns a copy so callers cannot mutate the registry in place', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'nautilus')
    ;(store.getRetiredWorktreeNameRegistry(REPO).names as string[]).push('seahorse')
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])
  })

  it('merges backfilled names without dropping a concurrent retirement', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'nautilus')
    expect(store.mergeRetiredWorktreeNames(REPO, ['seahorse', 'starfish'])).toBe(true)
    expect([...store.getRetiredWorktreeNameRegistry(REPO).names].sort()).toEqual([
      'nautilus',
      'seahorse',
      'starfish'
    ])
  })

  it('reports no change when a merge adds nothing new', async () => {
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'nautilus')
    expect(store.mergeRetiredWorktreeNames(REPO, ['NAUTILUS'])).toBe(false)
  })

  it('survives a reload so retirement outlives the workspace and the app session', async () => {
    const store = await createStore({
      retiredWorktreeNamesByRepo: { [REPO]: ['nautilus', 'seahorse'] }
    })
    expect([...store.getRetiredWorktreeNameRegistry(REPO).names].sort()).toEqual([
      'nautilus',
      'seahorse'
    ])
  })

  it('degrades to nothing retired when the persisted map is corrupt', async () => {
    const store = await createStore({ retiredWorktreeNamesByRepo: 'not-an-object' })
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual([])
  })

  it('drops non-string entries but keeps the valid ones', async () => {
    const store = await createStore({
      retiredWorktreeNamesByRepo: { [REPO]: ['nautilus', 42, null, 'Seahorse'] }
    })
    expect([...store.getRetiredWorktreeNameRegistry(REPO).names].sort()).toEqual([
      'nautilus',
      'seahorse'
    ])
  })

  it('drops the registry when the repo is removed, matching the sparse-preset convention', async () => {
    const store = await createStore()
    store.addRepo({ id: REPO, path: '/repos/a', displayName: 'a', badgeColor: '', addedAt: 0 })
    store.addRetiredWorktreeName(REPO, 'nautilus')

    store.removeProjectForHost({ id: REPO, executionHostId: 'local' })

    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual([])
  })

  it('reassociates remote retirements after remove and re-add mints a new repo id', async () => {
    const oldRepo = {
      id: REPO,
      path: '/remote/repos/a',
      displayName: 'a',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    let store = await createStore()
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(oldRepo) })
    store.flush()

    store = await reloadStore()
    const newRepo = { ...oldRepo, id: OTHER_REPO }
    store.addRepo(newRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('preserves a Codex-only local retirement across remove and re-add', async () => {
    const workspaceDir = join(testState.dir, 'workspaces')
    const oldRepo = {
      id: REPO,
      path: join(testState.dir, 'repos', 'a'),
      displayName: 'a',
      badgeColor: '',
      addedAt: 0
    }
    const store = await createStore()
    store.updateSettings({ workspaceDir, nestWorkspaces: false })
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')

    // No Claude history exists to recover this retirement, and Codex rollouts are not backfilled.
    store.removeProjectForHost({ id: REPO, executionHostId: 'local' })
    const newRepo = { ...oldRepo, id: OTHER_REPO }
    store.addRepo(newRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('preserves a remote retirement when an SSH target id rotates before re-add', async () => {
    const store = await createStore()
    store.addSshTarget(sshTarget('ssh-old'))
    const oldRepo = { ...REMOTE_REPO, connectionId: 'ssh-old' }
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')

    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(oldRepo) })
    store.removeSshTarget('ssh-old')
    store.addSshTarget(sshTarget('ssh-new'))
    const newRepo = { ...oldRepo, id: OTHER_REPO, connectionId: 'ssh-new' }
    store.addRepo(newRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('does not leak a remote retirement to an SSH target on a different endpoint', async () => {
    const store = await createStore()
    store.addSshTarget(sshTarget('ssh-old'))
    store.addSshTarget(sshTarget('ssh-other', { host: 'other.example.com' }))
    const oldRepo = { ...REMOTE_REPO, connectionId: 'ssh-old' }
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')

    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(oldRepo) })
    const otherRepo = { ...oldRepo, id: OTHER_REPO, connectionId: 'ssh-other' }
    store.addRepo(otherRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, otherRepo, [otherRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: [] })
  })

  it('reassigning a target id carries retirements written before endpoint identity', async () => {
    // Legacy namespace keys used target-row IDs instead of endpoint identity.
    const store = await createStore({
      retiredWorktreeNamesByNamespace: {
        'ssh:ssh-old:posix:/remote/repos/a-orca-retirement-probe': {
          exhaustedTiers: 0,
          names: ['nautilus']
        }
      }
    })
    store.addSshTarget(sshTarget('ssh-new'))
    const repo = { ...REMOTE_REPO, connectionId: 'ssh-old' }
    store.addRepo(repo)
    store.reassignSshTargetId('ssh-old', 'ssh-new')

    const { getRetiredNameRegistryForRepo } = await import('./worktree-name-retirement')
    const readopted = store.getRepos().find((entry) => entry.id === REPO)!
    expect(readopted.connectionId).toBe('ssh-new')
    await expect(
      getRetiredNameRegistryForRepo(store, readopted, [readopted], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('reassigning a target id carries retirements when the endpoint itself moved', async () => {
    const store = await createStore()
    store.addSshTarget(sshTarget('ssh-old', { configHost: 'builder', host: 'old.example.com' }))
    const repo = { ...REMOTE_REPO, connectionId: 'ssh-old' }
    store.addRepo(repo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, repo, store.getSettings(), 'nautilus')

    // Remove the repo so only the namespace retains the retirement.
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(repo) })
    // Unchanged ssh-config aliases can establish re-adoption after an endpoint moves.
    store.removeSshTarget('ssh-old')
    store.addRemovedSshTargetTombstone({
      oldTargetId: 'ssh-old',
      configHost: 'builder',
      host: 'old.example.com',
      port: 22,
      username: 'dev',
      label: 'builder',
      removedAt: 0
    })
    store.addSshTarget(sshTarget('ssh-new', { configHost: 'builder', host: 'new.example.com' }))
    store.reassignSshTargetId('ssh-old', 'ssh-new')

    const newRepo = { ...repo, id: OTHER_REPO, connectionId: 'ssh-new' }
    store.addRepo(newRepo)
    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('carries retirements across an in-place endpoint edit, which keeps the target id', async () => {
    // In-place config edits change endpoint-derived namespaces without triggering target re-adoption.
    const store = await createStore()
    store.addSshTarget(sshTarget('ssh-1', { configHost: 'builder', host: 'old.example.com' }))
    const repo = { ...REMOTE_REPO, connectionId: 'ssh-1' }
    store.addRepo(repo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, repo, store.getSettings(), 'nautilus')

    store.updateSshTarget('ssh-1', { host: 'new.example.com' })

    // Remove the repo so the namespace mirror is the only remaining retirement source.
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(repo) })
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: 'ssh-1' }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('does not spend namespace slots on on-demand runtime workspaces', async () => {
    // Disposable runtime filesystems cannot reuse retirements; mirroring them would evict durable hosts’ entries.
    const store = await createStore()
    const runtimeId = getRuntimeOwnedSshTargetId('vm-1')
    store.addSshTarget({
      ...sshTarget(runtimeId, { host: 'vm-old.example.com' }),
      owner: { type: 'on-demand-runtime', runtimeId: 'vm-1' }
    })
    const repo = { ...REMOTE_REPO, connectionId: runtimeId }
    store.addRepo(repo)
    const { retireGeneratedWorktreeName, getRemoteRetirementNamespaceKey } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, repo, store.getSettings(), 'nautilus')

    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])
    const namespaceKey = getRemoteRetirementNamespaceKey(repo, store.getSettings(), (id) =>
      store.getSshTarget(id)
    )!
    expect(store.getRetiredWorktreeNameRegistryForNamespace(namespaceKey).names).toEqual([])
  })

  it('does not carry retirements forward when an on-demand runtime target is reprovisioned', async () => {
    // Reprovisioned filesystems need no prior retirements; copying them only churns the namespace cap.
    const store = await createStore()
    const runtimeId = getRuntimeOwnedSshTargetId('vm-1')
    store.addSshTarget({
      ...sshTarget(runtimeId, { host: 'vm-old.example.com' }),
      owner: { type: 'on-demand-runtime', runtimeId: 'vm-1' }
    })
    const repo = { ...REMOTE_REPO, connectionId: runtimeId }
    store.addRepo(repo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, repo, store.getSettings(), 'nautilus')

    store.updateSshTarget(runtimeId, { host: 'vm-new.example.com' })

    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(repo) })
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: runtimeId }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: [] })
  })

  it('keeps a live sibling target its retirements when another row on the same endpoint rotates', async () => {
    const store = await createStore()
    // Distinct target rows may share an endpoint bucket; rotating one must preserve its sibling’s entries.
    store.addSshTarget(sshTarget('ssh-x', { configHost: 'builder', host: 'old.example.com' }))
    store.addSshTarget(sshTarget('ssh-y', { host: 'old.example.com' }))
    const sibling = { ...REMOTE_REPO, connectionId: 'ssh-y' }
    store.addRepo(sibling)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, sibling, store.getSettings(), 'nautilus')

    // Re-adopt the same config alias at a new endpoint.
    store.removeSshTarget('ssh-x')
    store.addRemovedSshTargetTombstone({
      oldTargetId: 'ssh-x',
      configHost: 'builder',
      host: 'old.example.com',
      port: 22,
      username: 'dev',
      label: 'builder',
      removedAt: 0
    })
    store.addSshTarget(sshTarget('ssh-x-new', { configHost: 'builder', host: 'new.example.com' }))
    store.reassignSshTargetId('ssh-x', 'ssh-x-new')

    // The sibling stays at its original endpoint; remove its repo so only the namespace holds the retirement.
    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(sibling) })
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: 'ssh-y' }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('shares one retirement bucket across SSH repos whose target row is gone', async () => {
    // Without endpoint identity, share a conservative bucket rather than reissue a name with history on disk.
    const store = await createStore()
    const oldRepo = { ...REMOTE_REPO, connectionId: 'ssh-old' }
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')

    store.removeProjectForHost({ id: REPO, executionHostId: getRepoExecutionHostId(oldRepo) })
    const newRepo = { ...oldRepo, id: OTHER_REPO, connectionId: 'ssh-new' }
    store.addRepo(newRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('bounds the namespace map instead of growing it for the life of the profile', async () => {
    // Namespaces outlive repo removal, so enforce their cap at the write boundary.
    const store = await createStore()
    for (let index = 0; index <= MAX_RETIREMENT_NAMESPACES; index += 1) {
      store.mergeRetiredWorktreeNamesForNamespace(`local:posix:/w/${index}`, ['nautilus'])
    }

    expect(store.getRetiredWorktreeNameRegistryForNamespace('local:posix:/w/0').names).toEqual([])
    expect(store.getRetiredWorktreeNameRegistryForNamespace('local:posix:/w/1').names).toEqual([
      'nautilus'
    ])
    expect(
      store.getRetiredWorktreeNameRegistryForNamespace(
        `local:posix:/w/${MAX_RETIREMENT_NAMESPACES}`
      ).names
    ).toEqual(['nautilus'])
  })

  it('keeps the registry when one host row is removed but the repo id survives elsewhere', async () => {
    const store = await createStore()
    store.addRepo({ id: REPO, path: '/repos/a', displayName: 'a', badgeColor: '', addedAt: 0 })
    store.addRepo({
      id: REPO,
      path: '/repos/a',
      displayName: 'a',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:env-1'
    } as never)
    store.addRetiredWorktreeName(REPO, 'nautilus')

    store.removeProjectForHost({ id: REPO, executionHostId: 'runtime:env-1' })

    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])

    store.removeProjectForHost({ id: REPO, executionHostId: 'local' })

    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual([])
  })

  it('compacts a completed tier instead of evicting, and still reports its names as retired', async () => {
    // A fully spent tier can compact into a watermark without forgetting any retired name.
    const store = await createStore()
    store.mergeRetiredWorktreeNames(REPO, POOL.slice(0, -1))
    expect(store.getRetiredWorktreeNameRegistry(REPO)).toMatchObject({ exhaustedTiers: 0 })
    expect(store.getRetiredWorktreeNameRegistry(REPO).names.length).toBe(POOL.length - 1)

    store.addRetiredWorktreeName(REPO, POOL.at(-1) as string)

    const registry = store.getRetiredWorktreeNameRegistry(REPO)
    expect(registry).toEqual({ exhaustedTiers: 1, names: [] })
    const isRetired = createRetiredNameLookup(registry)
    expect(POOL.every((name) => isRetired(name))).toBe(true)
  })

  it('keeps out-of-order higher-tier names when a lower tier compacts', async () => {
    // Collisions can spend higher-tier names before lower tiers finish; compaction must preserve them.
    const store = await createStore()
    store.addRetiredWorktreeName(REPO, 'nautilus-2')
    store.mergeRetiredWorktreeNames(REPO, POOL)

    expect(store.getRetiredWorktreeNameRegistry(REPO)).toEqual({
      exhaustedTiers: 1,
      names: ['nautilus-2']
    })
  })

  it('rolls the watermark through every tier that is already complete', async () => {
    const store = await createStore()
    store.mergeRetiredWorktreeNames(
      REPO,
      POOL.map((name) => `${name}-2`)
    )
    expect(store.getRetiredWorktreeNameRegistry(REPO).exhaustedTiers).toBe(0)

    store.mergeRetiredWorktreeNames(REPO, POOL)

    expect(store.getRetiredWorktreeNameRegistry(REPO)).toEqual({ exhaustedTiers: 2, names: [] })
  })

  it('stays bounded by one pool no matter how many tiers are spent', async () => {
    const store = await createStore()
    for (let tier = 1; tier <= 6; tier += 1) {
      store.mergeRetiredWorktreeNames(
        REPO,
        POOL.map((name) => (tier === 1 ? name : `${name}-${tier}`))
      )
    }

    const registry = store.getRetiredWorktreeNameRegistry(REPO)
    expect(registry).toEqual({ exhaustedTiers: 6, names: [] })
    expect(createRetiredNameLookup(registry)('nautilus-6')).toBe(true)
    expect(createRetiredNameLookup(registry)('nautilus-7')).toBe(false)
  })

  it('round-trips the watermark and the names above it through save and reload', async () => {
    const store = await createStore()
    store.mergeRetiredWorktreeNames(REPO, POOL)
    store.addRetiredWorktreeName(REPO, 'nautilus-2')
    store.flush()

    expect((await reloadStore()).getRetiredWorktreeNameRegistry(REPO)).toEqual({
      exhaustedTiers: 1,
      names: ['nautilus-2']
    })
  })

  it('loads the pre-compaction plain-array shape a developer profile may still hold', async () => {
    const store = await createStore({
      retiredWorktreeNamesByRepo: { [REPO]: [...POOL, 'nautilus-2'] }
    })

    expect(store.getRetiredWorktreeNameRegistry(REPO)).toEqual({
      exhaustedTiers: 1,
      names: ['nautilus-2']
    })
  })

  it('ignores a hand-written watermark that outruns the names it claims', async () => {
    // Reject malformed watermarks so a hand-edited value cannot silence the whole name pool.
    const store = await createStore({
      retiredWorktreeNamesByRepo: { [REPO]: { exhaustedTiers: -3, names: ['nautilus'] } }
    })

    expect(store.getRetiredWorktreeNameRegistry(REPO)).toEqual({
      exhaustedTiers: 0,
      names: ['nautilus']
    })
  })

  it('drops names a persisted watermark already covers', async () => {
    const store = await createStore({
      retiredWorktreeNamesByRepo: { [REPO]: { exhaustedTiers: 2, names: ['nautilus', 'orca-2'] } }
    })

    expect(store.getRetiredWorktreeNameRegistry(REPO)).toEqual({ exhaustedTiers: 2, names: [] })
  })

  it('drops legacy arbitrary names while loading the persisted map', async () => {
    const store = await createStore({
      retiredWorktreeNamesByRepo: { [REPO]: ['fix-login', 'Nautilus'] }
    })
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])
  })
})
