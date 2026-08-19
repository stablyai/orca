import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'
import type { SshTarget } from '../shared/ssh-types'
import { MAX_RETIREMENT_NAMESPACES } from './worktree-retirement-namespace'
import { getRuntimeOwnedSshTargetId } from './ssh/ssh-connection-store'

const testState = { dir: '' }

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
  initDataPath()
  return new Store()
}

async function createStore(persisted: Record<string, unknown> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), ...persisted }),
    'utf-8'
  )
  return reloadStore()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-worktree-name-retirement-'))
})

afterEach(() => {
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
    // Why: a load failure costs the app; over- or under-retiring costs at most a name.
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
    // Why: entries are repo-id keyed, so without this they orphan forever — a repo id is never
    // reused, and remove/re-add mints a new one.
    const store = await createStore()
    store.addRepo({ id: REPO, path: '/repos/a', displayName: 'a', badgeColor: '', addedAt: 0 })
    store.addRetiredWorktreeName(REPO, 'nautilus')

    store.removeProject(REPO)

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
    store.removeProject(REPO)
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

    // The deleted workspace has no Claude bucket; Codex rollout files are not backfilled.
    store.removeProject(REPO)
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

    // Removing and re-adding the host mints a fresh row id for the same machine and account.
    store.removeProject(REPO)
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

    store.removeProject(REPO)
    const otherRepo = { ...oldRepo, id: OTHER_REPO, connectionId: 'ssh-other' }
    store.addRepo(otherRepo)

    // A different machine has its own filesystem, so the spent name is free there.
    await expect(
      getRetiredNameRegistryForRepo(store, otherRepo, [otherRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: [] })
  })

  it('reassigning a target id carries retirements written before endpoint identity', async () => {
    // What the shipped code wrote: a namespace whose host half is the target row id.
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

    // Drop the repo row, so the namespace copy is the only thing left holding the tombstone.
    store.removeProject(REPO)
    // The ssh-config alias is unchanged, so re-adoption matches even though the host moved.
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
    // Config sync rewrites host/port/username on the existing row, so no re-adoption runs and the
    // endpoint-derived namespace key silently moves. Without a migration here the mirror strands.
    const store = await createStore()
    store.addSshTarget(sshTarget('ssh-1', { configHost: 'builder', host: 'old.example.com' }))
    const repo = { ...REMOTE_REPO, connectionId: 'ssh-1' }
    store.addRepo(repo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, repo, store.getSettings(), 'nautilus')

    // The user edits ~/.ssh/config; the next import refreshes the row in place, same id.
    store.updateSshTarget('ssh-1', { host: 'new.example.com' })

    // Drop the repo row the way a project remove/re-add does, leaving the mirror as the only source.
    store.removeProject(REPO)
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: 'ssh-1' }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('does not spend namespace slots on on-demand runtime workspaces', async () => {
    // Each provision reaches a discarded filesystem under a fresh address, so a mirror written here
    // could never be read back — it would only consume the cap and evict real projects' tombstones.
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

    // The repo-id row still records it for the live session; the shared namespace map does not.
    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])
    const namespaceKey = getRemoteRetirementNamespaceKey(repo, store.getSettings(), (id) =>
      store.getSshTarget(id)
    )!
    expect(store.getRetiredWorktreeNameRegistryForNamespace(namespaceKey).names).toEqual([])
  })

  it('does not carry retirements forward when an on-demand runtime target is reprovisioned', async () => {
    // Each provision mints a fresh address onto a discarded filesystem, so the old names collide
    // with nothing. Copying per run would also churn the namespace cap out from under real hosts.
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

    store.removeProject(REPO)
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: runtimeId }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: [] })
  })

  it('keeps a live sibling target its retirements when another row on the same endpoint rotates', async () => {
    const store = await createStore()
    // Two rows, one endpoint: nothing dedupes SSH targets by host|port|username, so the endpoint
    // bucket is shared and is not owned by whichever row happens to rotate.
    store.addSshTarget(sshTarget('ssh-x', { configHost: 'builder', host: 'old.example.com' }))
    store.addSshTarget(sshTarget('ssh-y', { host: 'old.example.com' }))
    const sibling = { ...REMOTE_REPO, connectionId: 'ssh-y' }
    store.addRepo(sibling)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, sibling, store.getSettings(), 'nautilus')

    // `ssh-x` is removed and re-imported with a moved HostName; its alias still matches, so
    // re-adoption rotates it onto a new endpoint.
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

    // `ssh-y` never moved. Drop its repo row the way a project remove/re-add does, so the namespace
    // copy is the only thing left holding the tombstone.
    store.removeProject(REPO)
    const readded = { ...REMOTE_REPO, id: OTHER_REPO, connectionId: 'ssh-y' }
    store.addRepo(readded)
    await expect(
      getRetiredNameRegistryForRepo(store, readded, [readded], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('shares one retirement bucket across SSH repos whose target row is gone', async () => {
    // No target row means no endpoint to compare. Retirement prefers spending one name out of the
    // pool over reissuing a cwd whose agent history is still on disk, so these share a bucket.
    const store = await createStore()
    const oldRepo = { ...REMOTE_REPO, connectionId: 'ssh-old' }
    store.addRepo(oldRepo)
    const { getRetiredNameRegistryForRepo, retireGeneratedWorktreeName } =
      await import('./worktree-name-retirement')
    await retireGeneratedWorktreeName(store, oldRepo, store.getSettings(), 'nautilus')

    store.removeProject(REPO)
    const newRepo = { ...oldRepo, id: OTHER_REPO, connectionId: 'ssh-new' }
    store.addRepo(newRepo)

    await expect(
      getRetiredNameRegistryForRepo(store, newRepo, [newRepo], store.getSettings())
    ).resolves.toEqual({ exhaustedTiers: 0, names: ['nautilus'] })
  })

  it('bounds the namespace map instead of growing it for the life of the profile', async () => {
    // Nothing prunes this map per repo — surviving a project removal is the point — so the store
    // write is the only place the cap can be applied.
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

    store.removeProjectForHost(REPO, 'runtime:env-1')

    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual(['nautilus'])

    store.removeProjectForHost(REPO, 'local')

    expect(store.getRetiredWorktreeNameRegistry(REPO).names).toEqual([])
  })

  it('compacts a completed tier instead of evicting, and still reports its names as retired', async () => {
    // The registry is a correctness guarantee, so it can never drop a name. It stays bounded by
    // folding a fully spent tier into the watermark — the one case where dropping the entries
    // loses nothing, because every name in that tier is spent.
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
    // A create-time collision can spend `nautilus-2` while tier 1 is still open, so tiers do not
    // fill in order and compacting tier 1 must not take the tier-2 name with it.
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
    // Why not trust it: over-retiring costs a name, and the watermark is the cheapest thing to
    // hand-edit. Clamping garbage to none keeps a bad value from silencing the whole pool.
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
