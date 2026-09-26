/**
 * `setWorktreeMetaForHost` puts one object in both `worktreeMeta` and `worktreeMetaByIdentity`, so
 * a heavy profile serializes every metadata row twice. On a measured 3.64 MB install 1,347 of
 * 1,349 locator rows were byte-identical to their identity twin and cost 540 KB per save.
 *
 * These tests drive the real Store over a seeded corpus that contains every shape the projection
 * has to get right -- identical twins, divergent twins, rows with no identity at all, one locator
 * claimed by two hosts, an alias whose locator row was pruned away, a dangling identity key, and
 * an ambiguous alias with two instances behind one locator -- and pin the properties that make the
 * omission safe: load(save(x)) deep-equals x, an old-serializer file and a new-serializer file load
 * to the same state, the locator map is never reduced (which is what makes a downgrade lossless),
 * and a build with no rebuild at all recovers every row from the file the new build wrote.
 */
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
/** Recent enough that the 30-day stale-metadata GC leaves the fixture alone. */
const RECENTLY = Date.now()

/** Seeded so the corpus is the same on every run and a failure is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const stores: InstanceType<typeof Store>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  vi.restoreAllMocks()
})

function openStore(dataFile: string): InstanceType<typeof Store> {
  const store = new Store({ dataFile })
  stores.push(store)
  return store
}

function tempDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-alias-projection-'))), 'orca-data.json')
}

function worktreeId(index: number): string {
  return `${REPO_ID}::/tmp/wt-${index}`
}

/** Every optional slot exercised on a fraction of rows, so a row that must stay written does. */
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

/**
 * A file in the pre-change shape: every alias' identity row duplicated into `worktreeMeta`, which
 * is exactly what the old serializer wrote.
 */
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

  // 1. The common case: the identity row and the locator row are the same value.
  for (let index = 0; index < TWIN_ROWS; index++) {
    const row = meta(index, random)
    worktreeMeta[worktreeId(index)] = { ...row }
    omittable.push(link(worktreeId(index), LOCAL, row))
  }
  // 2. Divergent twin: the locator row carries a value the identity row does not.
  const divergent = worktreeId(TWIN_ROWS)
  const divergentRow = meta(TWIN_ROWS, random)
  worktreeMeta[divergent] = { ...divergentRow, displayName: 'locator-only-name' }
  irreducible.push(link(divergent, LOCAL, divergentRow))
  // 3. No identity twin at all, and no hostId — the shape of Orca's synthetic pseudo-worktrees.
  for (const pseudo of ['global-floating-terminal', 'onboarding-setup-terminal']) {
    worktreeMeta[pseudo] = meta(0, random, { hostId: undefined, displayName: pseudo })
  }
  // 4. One locator claimed by two hosts: nothing on disk records which one owns the projection.
  const contested = worktreeId(TWIN_ROWS + 1)
  const localClaim = meta(TWIN_ROWS + 1, random)
  const remoteClaim = meta(TWIN_ROWS + 1, random, {
    hostId: REMOTE as never,
    instanceId: `instance-${TWIN_ROWS + 1}-remote`,
    lastActivityAt: RECENTLY + 99_999
  })
  worktreeMeta[contested] = { ...localClaim }
  // Only the host the locator row names can regenerate a key from it, so the other host's row stays.
  omittable.push(link(contested, LOCAL, localClaim))
  irreducible.push(link(contested, REMOTE, remoteClaim))
  // 5. An alias whose locator row a host-scoped prune already removed: rebuilding it would
  //    resurrect a workspace the user deleted.
  const voided = worktreeId(TWIN_ROWS + 2)
  irreducible.push(link(voided, REMOTE, meta(TWIN_ROWS + 2, random, { hostId: REMOTE as never })))
  // 6. A dangling identity key: the alias points at a row that is not there.
  const dangling = worktreeId(TWIN_ROWS + 3)
  worktreeMeta[dangling] = meta(TWIN_ROWS + 3, random)
  worktreeIdentityAliases[composeWorktreeHostIdentity(LOCAL, dangling)] = ['wt2:local:missing']
  // 7. An ambiguous alias — two instances behind one locator. `setWorktreeMetaForHost` refuses to
  //    write one, so it is a repair state and its locator row must stay written in full.
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

    // One load+flush first, so the baseline is not comparing against the one-time settings
    // migrations a synthetic fixture triggers (same reason as state-write-round-trip.test.ts).
    openStore(dataFile).flush()

    const loaded = openStore(dataFile)
    const before = snapshot(loaded)
    loaded.flush()
    const rewritten = readFileSync(dataFile, 'utf-8')
    const onDisk = JSON.parse(rewritten) as PersistedState

    // The counter this change exists for: 401 regenerable identity rows leave the file.
    expect(Object.keys(onDisk.worktreeMetaByIdentity ?? {}).sort()).toEqual(
      [...fixture.irreducible].sort()
    )
    expect(fixture.omittable).toHaveLength(TWIN_ROWS + 1)
    // ...and the locator map, which is what regenerates them, is written in full. This is the
    // property the downgrade story rests on, so it is asserted as a set, not a count.
    expect(Object.keys(onDisk.worktreeMeta).sort()).toEqual(Object.keys(before.meta).sort())

    // load(save(x)) deep-equals x, for every reader of the metadata maps.
    const reloaded = openStore(dataFile)
    expect(reloaded.getAllWorktreeMeta()).toEqual(before.meta)
    expect(reloaded.getAllWorktreeMetaForHost(LOCAL)).toEqual(before.local)
    expect(reloaded.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(before.remote)
    // The locator row a host-scoped prune already removed stays removed.
    expect(reloaded.getAllWorktreeMeta()).not.toHaveProperty(worktreeId(TWIN_ROWS + 2))
    // The contested locator keeps the host that owned the projection, not the newer claim.
    expect(reloaded.getAllWorktreeMeta()[worktreeId(TWIN_ROWS + 1)]?.hostId).toBe(LOCAL)
    // The ambiguous locator keeps its own row, not the newer instance behind the same alias.
    expect(reloaded.getAllWorktreeMeta()[worktreeId(TWIN_ROWS + 4)]?.displayName).toBe(
      `workspace-${TWIN_ROWS + 4}`
    )

    // A quiet app does not rewrite the file with new content on the next flush.
    reloaded.flush()
    expect(readFileSync(dataFile, 'utf-8')).toBe(rewritten)
  })

  /**
   * The risk this projection direction exists to remove. A build without the rebuild -- an older
   * one, or any raw reader of the file -- gets a complete `worktreeMeta`; its normalizer drops the
   * now-dangling aliases and `migrateLegacyWorktreeMetadata` re-mints the identical identity key
   * from the `instanceId` the locator row still carries. Nothing is lost at any step.
   */
  it('loses no row on a build that has no rebuild at all', () => {
    const fixture = buildFixture()
    const dataFile = tempDataFile()
    writeFixture(dataFile, fixture.state)
    openStore(dataFile).flush()
    const upgraded = openStore(dataFile)
    const before = snapshot(upgraded)
    upgraded.flush()

    // What a build without this change does with that file: parse it, run the metadata normalizer
    // it already ships (untouched here), write the result back.
    const downgraded = JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
    normalizeWorktreeLinkedItemMetadata(downgraded)
    expect(Object.keys(downgraded.worktreeMeta).sort()).toEqual(Object.keys(before.meta).sort())
    // It drops the aliases whose identity row is not there; it never touches a locator row.
    expect(downgraded.worktreeIdentityAliases).not.toHaveProperty(
      composeWorktreeHostIdentity(LOCAL, worktreeId(0))
    )
    writeFileSync(dataFile, JSON.stringify(downgraded), 'utf-8')

    // Every reader is where it started, with no rebuild and without touching a row first.
    const rolledBack = openStore(dataFile)
    expect(rolledBack.getAllWorktreeMeta()).toEqual(before.meta)
    expect(rolledBack.getAllWorktreeMetaForHost(LOCAL)).toEqual(before.local)
    expect(rolledBack.getAllWorktreeMetaForHost(REMOTE as never)).toEqual(before.remote)

    // ...and the first touch re-mints the SAME identity key the save omitted, so re-upgrading
    // compacts the same row again rather than stranding a second lineage for it.
    expect(rolledBack.getWorktreeMetaForHost(worktreeId(0), LOCAL)).toEqual(
      before.meta[worktreeId(0)]
    )
    rolledBack.flush()
    const reminted = JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
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
    // JSON.parse splits the one object the write path shared into two; the rebuild puts it back,
    // worth ~0.46 MB of heap on the measured 3.64 MB profile.
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
    // Writing it back produces the new, projected shape in place.
    fromLegacy.flush()

    const compactFile = tempDataFile()
    writeFileSync(compactFile, readFileSync(legacyFile))
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
      // Nothing resolvable, so nothing is omitted -- and a garbled alias map costs exactly what it
      // costs today, because every row's name/pin/links is still in the locator map.
      expect(Object.keys(store.getAllWorktreeMeta()).length).toBe(
        Object.keys(fixture.state.worktreeMeta).length
      )
      expect(store.getAllWorktreeMeta()[worktreeId(0)]?.displayName).toBe('workspace-0')
      store.flush()
      const onDisk = JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
      expect(Object.keys(onDisk.worktreeMeta).length).toBe(
        Object.keys(fixture.state.worktreeMeta).length
      )
      // The identity rows a garbled alias map strands are pruned exactly as they are today; the
      // projection never adds to that, because it only omits a row an alias can rebuild.
      expect(openStore(dataFile).getAllWorktreeMeta()).toEqual(store.getAllWorktreeMeta())
    }
  })

  /**
   * A file that never had an identity map must not gain one: the rebuild returns the parsed value
   * unchanged for a non-record, so an unconditional spread would give the loaded state an own
   * `worktreeMetaByIdentity: undefined` -- a key that outranks the defaults spread and reaches
   * every `Object.hasOwn`/`in` reader as present-but-empty.
   */
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

    const onDisk = JSON.parse(readFileSync(dataFile, 'utf-8')) as PersistedState
    expect(Object.hasOwn(onDisk, 'worktreeMetaByIdentity')).toBe(false)
    // The locator map and its lineage companions are all still there, untouched by the projection.
    expect(Object.keys(onDisk.worktreeMeta)).toEqual([worktreeId(0)])
    expect(Object.keys(onDisk.worktreeLineageById)).toEqual([`${REPO_ID}::/tmp/child`])
    expect(Object.keys(onDisk.workspaceLineageByChildKey)).toEqual([
      `worktree:${REPO_ID}::/tmp/child`
    ])
  })
})
