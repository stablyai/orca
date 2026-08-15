import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import { MARINE_CREATURES } from '../shared/marine-creatures'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'

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
