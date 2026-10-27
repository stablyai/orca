import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedState,
  readPersistedStateJson
} from '../persistence-test-harness'
// Regenerable identity rows may be omitted only when readers retain complete locator metadata.
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { normalizeWorktreeLinkedItemMetadata } from '../tracking-repos/worktree-metadata-normalization'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const REPO_ID = 'repo-1'
const LOCAL = 'local'
const REMOTE = 'ssh:user@host'
const TWIN_ROWS = 400
// Keep fixture metadata newer than the 30-day GC cutoff.
const RECENTLY = Date.now()

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const stores: InstanceType<typeof Store>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = createSqliteTestStore(Store, { dataFile })
  stores.push(store)
  return store
}

function tempDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-alias-projection-'))), 'orca-data.json')
}

function worktreeId(index: number): string {
  return `${REPO_ID}::/tmp/wt-${index}`
}

function meta(index: number, random: () => number, overrides: Partial<WorktreeMeta> = {}) {
  const rich = random() < 0.25
  return {
    instanceId: `instance-${index}`,
    hostId: LOCAL,
    displayName: `workspace-${index}`,
    comment: rich ? `note ${index}` : '',
    linkedIssue: null,
    linkedPR: rich ? index : null,
    linkedLinearIssue: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: random() < 0.3,
    isPinned: rich,
    sortOrder: RECENTLY + index,
    manualOrder: rich ? index : undefined,
    lastActivityAt: RECENTLY + index,
    createdAt: RECENTLY,
    baseRef: rich ? 'main' : undefined,
    workspaceStatus: 'none',
    ...overrides
  } as WorktreeMeta
}

type Fixture = {
  state: PersistedState
  /** Identity keys the locator row regenerates on its own, so they must leave the file. */
  omittable: string[]
  /** Identity keys no locator row regenerates, so they must stay on disk. */
  irreducible: string[]
}

function buildFixture(): Fixture {
  const random = seededRandom(20_260_903)
  const worktreeMeta: Record<string, WorktreeMeta> = {}
  const worktreeMetaByIdentity: Record<string, WorktreeMeta> = {}
  const worktreeIdentityAliases: Record<string, string[]> = {}
  const omittable: string[] = []
  const irreducible: string[] = []

  const link = (id: string, host: string, row: WorktreeMeta): string => {
    const identityKey = canonicalWorktreeIdentity({
      worktreeId: id,
      executionHostId: host as never,
      instanceId: row.instanceId as string
    })
    worktreeMetaByIdentity[identityKey] = row
    worktreeIdentityAliases[composeWorktreeHostIdentity(host as never, id)] = [identityKey]
    return identityKey
  }

  for (let index = 0; index < TWIN_ROWS; index++) {
    const row = meta(index, random)
    worktreeMeta[worktreeId(index)] = { ...row }
    omittable.push(link(worktreeId(index), LOCAL, row))
  }
  const divergent = worktreeId(TWIN_ROWS)
  const divergentRow = meta(TWIN_ROWS, random)
  worktreeMeta[divergent] = { ...divergentRow, displayName: 'locator-only-name' }
  irreducible.push(link(divergent, LOCAL, divergentRow))
  for (const pseudo of ['global-floating-terminal', 'onboarding-setup-terminal']) {
    worktreeMeta[pseudo] = meta(0, random, { hostId: undefined, displayName: pseudo })
  }
  const contested = worktreeId(TWIN_ROWS + 1)
  const localClaim = meta(TWIN_ROWS + 1, random)
  const remoteClaim = meta(TWIN_ROWS + 1, random, {
    hostId: REMOTE as never,
    instanceId: `instance-${TWIN_ROWS + 1}-remote`,
    lastActivityAt: RECENTLY + 99_999
  })
  worktreeMeta[contested] = { ...localClaim }
  omittable.push(link(contested, LOCAL, localClaim))
  irreducible.push(link(contested, REMOTE, remoteClaim))
  // A pruned locator must stay absent rather than resurrect a deleted workspace.
  const voided = worktreeId(TWIN_ROWS + 2)
  irreducible.push(link(voided, REMOTE, meta(TWIN_ROWS + 2, random, { hostId: REMOTE as never })))
  const dangling = worktreeId(TWIN_ROWS + 3)
  worktreeMeta[dangling] = meta(TWIN_ROWS + 3, random)
  worktreeIdentityAliases[composeWorktreeHostIdentity(LOCAL, dangling)] = ['wt2:local:missing']
  // Ambiguous aliases cannot regenerate a unique identity, so retain their full locator row.
  const ambiguous = worktreeId(TWIN_ROWS + 4)
  const claimA = meta(TWIN_ROWS + 4, random)
  const claimB = meta(TWIN_ROWS + 4, random, {
    instanceId: `instance-${TWIN_ROWS + 4}-b`,
    displayName: 'second-instance',
    lastActivityAt: RECENTLY + 99_999
  })
  worktreeMeta[ambiguous] = { ...claimA }
  const ambiguousKey = link(ambiguous, LOCAL, claimA)
  irreducible.push(ambiguousKey)
  const secondKey = canonicalWorktreeIdentity({
    worktreeId: ambiguous,
    executionHostId: LOCAL as never,
    instanceId: claimB.instanceId as string
  })
  worktreeMetaByIdentity[secondKey] = claimB
  worktreeIdentityAliases[composeWorktreeHostIdentity(LOCAL, ambiguous)] = [ambiguousKey, secondKey]
  irreducible.push(secondKey)

  return {
    state: {
      // Registered: the load-time deregistered-repo sweep drops residue rows for unknown repos.
      repos: [{ id: REPO_ID, name: REPO_ID, path: '/tmp/repo-1', worktreesPath: '/tmp' }],
      projects: [],
      worktreeMeta,
      worktreeMetaByIdentity,
      worktreeIdentityAliases,
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    } as unknown as PersistedState,
    omittable,
    irreducible
  }
}

function writeFixture(dataFile: string, state: PersistedState): void {
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
}

function snapshot(store: InstanceType<typeof Store>) {
  return {
    meta: structuredClone(store.getAllWorktreeMeta()),
    local: structuredClone(store.getAllWorktreeMetaForHost(LOCAL)),
    remote: structuredClone(store.getAllWorktreeMetaForHost(REMOTE as never))
  }
}

describe('worktree meta alias projection', () => {
  it('round-trips every corpus shape and writes only the identity rows no locator regenerates', () => {
    const fixture = buildFixture()
    const dataFile = tempDataFile()
    writeFixture(dataFile, fixture.state)

    // Settle one-time fixture migrations before comparing serialization.
    openStore(dataFile).flush()

    const loaded = openStore(dataFile)
    const before = snapshot(loaded)
    loaded.flush()
    const rewritten = readPersistedStateJson(dataFile)
    const onDisk = JSON.parse(rewritten) as PersistedState

    expect(Object.keys(onDisk.worktreeMetaByIdentity ?? {}).sort()).toEqual(
      [...fixture.irreducible].sort()
    )
    expect(fixture.omittable).toHaveLength(TWIN_ROWS + 1)
    // Assert complete locator keys because they are required for lossless downgrade.
    expect(Object.keys(onDisk.worktreeMeta).sort()).toEqual(Object.keys(before.meta).sort())

    const reloaded = openStore(dataFile)
    expect(reloaded.getAllWorktreeMeta()).toEqual(before.meta)
    expect(reloaded.getAllWorktreeMetaForHost(LOCAL)).toEqual(before.local)
    expect(reloaded.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(before.remote)
    expect(reloaded.getAllWorktreeMeta()).not.toHaveProperty(worktreeId(TWIN_ROWS + 2))
    expect(reloaded.getAllWorktreeMeta()[worktreeId(TWIN_ROWS + 1)]?.hostId).toBe(LOCAL)
    expect(reloaded.getAllWorktreeMeta()[worktreeId(TWIN_ROWS + 4)]?.displayName).toBe(
      `workspace-${TWIN_ROWS + 4}`
    )

    reloaded.flush()
    expect(readPersistedStateJson(dataFile)).toBe(rewritten)
  })

  // Exercise metadata normalization before reimport without claiming this simulates every older build.
  it('preserves rows through metadata normalization before current Store reimport', () => {
    const fixture = buildFixture()
    const dataFile = tempDataFile()
    writeFixture(dataFile, fixture.state)
    openStore(dataFile).flush()
    const upgraded = openStore(dataFile)
    const before = snapshot(upgraded)
    upgraded.flush()

    const downgraded = readPersistedState(dataFile)
    normalizeWorktreeLinkedItemMetadata(downgraded)
    expect(Object.keys(downgraded.worktreeMeta).sort()).toEqual(Object.keys(before.meta).sort())
    expect(downgraded.worktreeIdentityAliases).not.toHaveProperty(
      composeWorktreeHostIdentity(LOCAL, worktreeId(0))
    )
    const rollbackDataFile = tempDataFile()
    writeFileSync(rollbackDataFile, JSON.stringify(downgraded), 'utf-8')

    const rolledBack = openStore(rollbackDataFile)
    expect(rolledBack.getAllWorktreeMeta()).toEqual(before.meta)
    expect(rolledBack.getAllWorktreeMetaForHost(LOCAL)).toEqual(before.local)
    expect(rolledBack.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(before.remote)

    // First access must remint the same identity key so re-upgrade compacts the same lineage.
    expect(rolledBack.getWorktreeMetaForHost(worktreeId(0), LOCAL)).toEqual(
      before.meta[worktreeId(0)]
    )
    rolledBack.flush()
    const reminted = readPersistedState(rollbackDataFile)
    expect(
      reminted.worktreeIdentityAliases?.[composeWorktreeHostIdentity(LOCAL, worktreeId(0))]
    ).toEqual([
      canonicalWorktreeIdentity({
        worktreeId: worktreeId(0),
        executionHostId: LOCAL as never,
        instanceId: 'instance-0'
      })
    ])
  })

  it('rebuilds the identity rows as the same objects the locator map holds', () => {
    const fixture = buildFixture()
    const dataFile = tempDataFile()
    writeFixture(dataFile, fixture.state)
    openStore(dataFile).flush()

    const store = openStore(dataFile)
    const rebuilt = store.getAllWorktreeMeta()
    // JSON parsing duplicates shared objects; rebuild must restore shared references.
    let shared = 0
    for (let index = 0; index < TWIN_ROWS; index++) {
      if (store.getWorktreeMetaForHost(worktreeId(index), LOCAL) === rebuilt[worktreeId(index)]) {
        shared++
      }
    }
    expect(shared).toBe(TWIN_ROWS)
  })

  it('loads an old-serializer file and a new-serializer file to the same state', () => {
    const fixture = buildFixture()
    const legacyFile = tempDataFile()
    writeFixture(legacyFile, fixture.state)
    const fromLegacy = openStore(legacyFile)
    fromLegacy.flush()

    const compactFile = tempDataFile()
    writeFileSync(compactFile, readPersistedStateJson(legacyFile))
    const fromCompact = openStore(compactFile)

    expect(fromCompact.getAllWorktreeMeta()).toEqual(fromLegacy.getAllWorktreeMeta())
    expect(fromCompact.getAllWorktreeMetaForHost(LOCAL)).toEqual(
      fromLegacy.getAllWorktreeMetaForHost(LOCAL)
    )
    expect(fromCompact.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(
      fromLegacy.getAllWorktreeMetaForHost(REMOTE as never)
    )
  })

  it('keeps every locator row when the alias map is missing or unreadable', () => {
    for (const aliases of [undefined, null, [], { 'local|x': 'not-an-array' }]) {
      const fixture = buildFixture()
      const dataFile = tempDataFile()
      writeFixture(dataFile, {
        ...fixture.state,
        worktreeIdentityAliases: aliases as never
      })
      const store = openStore(dataFile)
      // Malformed aliases cannot justify omitting a locator row.
      expect(Object.keys(store.getAllWorktreeMeta()).length).toBe(
        Object.keys(fixture.state.worktreeMeta).length
      )
      expect(store.getAllWorktreeMeta()[worktreeId(0)]?.displayName).toBe('workspace-0')
      store.flush()
      const onDisk = readPersistedState(dataFile)
      expect(Object.keys(onDisk.worktreeMeta).length).toBe(
        Object.keys(fixture.state.worktreeMeta).length
      )
      // Projection may omit only rows that valid aliases can reconstruct.
      expect(openStore(dataFile).getAllWorktreeMeta()).toEqual(store.getAllWorktreeMeta())
    }
  })

  // Do not materialize an absent identity map as undefined and override reader defaults.
  it('never materializes an identity map a file did not have', () => {
    const dataFile = tempDataFile()
    writeFileSync(
      dataFile,
      JSON.stringify({
        repos: [{ id: REPO_ID, name: REPO_ID, path: '/tmp/repo-1', worktreesPath: '/tmp' }],
        worktreeMeta: { [worktreeId(0)]: meta(0, seededRandom(1)) },
        worktreeLineageById: {
          [`${REPO_ID}::/tmp/child`]: {
            parentWorktreeId: `${REPO_ID}::/tmp/parent`,
            createdAt: RECENTLY
          }
        },
        workspaceLineageByChildKey: {
          [`worktree:${REPO_ID}::/tmp/child`]: {
            parentWorkspaceKey: `worktree:${REPO_ID}::/tmp/parent`,
            createdAt: RECENTLY
          }
        }
      }),
      'utf-8'
    )

    const store = openStore(dataFile)
    expect(Object.keys(store.getAllWorktreeMeta())).toEqual([worktreeId(0)])
    store.flush()

    const onDisk = readPersistedState(dataFile)
    expect(Object.hasOwn(onDisk, 'worktreeMetaByIdentity')).toBe(false)
    expect(Object.keys(onDisk.worktreeMeta)).toEqual([worktreeId(0)])
    expect(Object.keys(onDisk.worktreeLineageById)).toEqual([`${REPO_ID}::/tmp/child`])
    expect(Object.keys(onDisk.workspaceLineageByChildKey)).toEqual([
      `worktree:${REPO_ID}::/tmp/child`
    ])
  })
})
