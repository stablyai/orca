import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import type { ExecutionHostId } from '../shared/execution-host'
import type { PersistedState } from '../shared/persisted-state-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../shared/worktree/identity'
import { composeWorktreeHostIdentity } from '../shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  createSqliteTestStore,
  makeRepo,
  readPersistedStateJson
} from './persistence-test-harness'
import { Store } from './persistence/loading-store/store'
import type { StoreRuntimeState } from './persistence/loading-store/store-runtime-state'
import type { WorktreeMetadataExpectation } from './persistence/loading-store/worktree-metadata-admission'
import { persistRuntimeManagedWorktreeSortOrder } from './runtime/runtime-managed-worktree-metadata'
import { OrcaRuntimeService } from './runtime/orca-runtime'
import { registerWorktreeMetadataHandlers } from './ipc/worktrees/metadata/register-worktree-metadata-handlers'
import { createSenderScopedRequestCancellations } from './ipc/sender-scoped-request-cancellation'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler),
    on: vi.fn()
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    webContents = { send: vi.fn() }
    isDestroyed() {
      return false
    }
  }
}))

type MetadataTables = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>
type AdmissionInternals = {
  state: MetadataTables
  runtime: Pick<StoreRuntimeState, 'writeGeneration'>
}

export function metadataAdmissionFixture(store: Store, dataFile: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: A real Store owns these fields; this test fixture seeds incomplete identity tables without loader repair.
  const internals = store as unknown as AdmissionInternals
  return {
    snapshot: (): MetadataTables =>
      structuredClone({
        worktreeMeta: internals.state.worktreeMeta,
        worktreeMetaByIdentity: internals.state.worktreeMetaByIdentity,
        worktreeIdentityAliases: internals.state.worktreeIdentityAliases
      }),
    replaceTables: (tables: MetadataTables): void => {
      Object.assign(internals.state, structuredClone(tables))
    },
    writeGeneration: (): number => internals.runtime.writeGeneration,
    persisted: (): string => {
      store.flush()
      return readPersistedStateJson(dataFile)
    }
  }
}

const REPO_ID = 'repo-admission'
const WORKTREE_ID = `${REPO_ID}::${join(tmpdir(), 'metadata-admission-workspace')}`
const MISSING_ID = `${REPO_ID}::${join(tmpdir(), 'metadata-admission-missing')}`
const LOCAL_INSTANCE = 'local-instance'
const REMOTE_INSTANCE = 'remote-instance'
const REMOTE_HOST: ExecutionHostId = 'ssh:target-a'
const directories: string[] = []

afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  handlers.clear()
  vi.restoreAllMocks()
})

function openStore(hosts: ExecutionHostId[] = ['local']) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-metadata-admission-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  for (const executionHostId of hosts) {
    store.addRepo(
      makeRepo({
        id: REPO_ID,
        path: join(directory, 'project'),
        kind: 'folder',
        badgeColor: 'blue',
        executionHostId
      })
    )
  }
  return { store, dataFile, fixture: metadataAdmissionFixture(store, dataFile) }
}

type AdmissionStore = ReturnType<typeof openStore>

function identityKey(hostId: ExecutionHostId, instanceId: string): string {
  return canonicalWorktreeIdentity({ worktreeId: WORKTREE_ID, executionHostId: hostId, instanceId })
}

function expectRejected(
  { store, fixture }: AdmissionStore,
  worktreeId: string,
  expectation: WorktreeMetadataExpectation,
  updates: Partial<WorktreeMeta> = { comment: 'Rejected update' },
  current = false
): void {
  const persistedBefore = fixture.persisted()
  const before = fixture.snapshot()
  const generation = fixture.writeGeneration()
  expect(store.isCurrentWorktreeMetadata(worktreeId, expectation)).toBe(current)
  expect(store.updateExistingWorktreeMeta(worktreeId, updates, expectation)).toBeUndefined()
  expect(fixture.snapshot()).toEqual(before)
  expect(fixture.writeGeneration()).toBe(generation)
  expect(fixture.persisted()).toBe(persistedBefore)
}

type SortEntrypoint = 'runtime' | 'desktop'

function persistSortOrder(
  store: Store,
  entrypoint: SortEntrypoint,
  orderedIds: string[],
  updated: number
): void {
  if (entrypoint === 'runtime') {
    const invalidateResolved = vi.fn()
    const notifyChanged = vi.fn()
    expect(
      persistRuntimeManagedWorktreeSortOrder({
        store,
        orderedIds,
        invalidateResolved,
        notifyChanged
      })
    ).toEqual({ updated })
    expect(invalidateResolved).toHaveBeenCalledTimes(updated === 0 ? 0 : 1)
    expect(notifyChanged.mock.calls).toEqual(updated === 0 ? [] : [[REPO_ID]])
    return
  }
  registerWorktreeMetadataHandlers({
    store,
    runtime: new OrcaRuntimeService(store),
    mainWindow: new BrowserWindow({ show: false }),
    detectedWorktreeCancellations: createSenderScopedRequestCancellations(),
    worktreeRemovalsInFlight: new Map()
  })
  const handler = handlers.get('worktrees:persistSortOrder')
  if (!handler) {
    throw new Error('fixture_missing_sort_handler')
  }
  handler({}, { orderedIds })
}

function expectSortUnchanged(
  context: AdmissionStore,
  entrypoint: SortEntrypoint,
  orderedIds: string[]
): void {
  const persistedBefore = context.fixture.persisted()
  const before = context.fixture.snapshot()
  const generation = context.fixture.writeGeneration()
  persistSortOrder(context.store, entrypoint, orderedIds, 0)
  expect(context.fixture.snapshot()).toEqual(before)
  expect(context.fixture.writeGeneration()).toBe(generation)
  expect(context.fixture.persisted()).toBe(persistedBefore)
}

describe('existing worktree metadata admission in the SQLite Store', () => {
  it('refuses missing metadata without creating identity or scheduling persistence', () => {
    const context = openStore()
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })

    expectRejected(context, MISSING_ID, { executionHostId: 'local', instanceId: LOCAL_INSTANCE })
    expect(context.store.getWorktreeMeta(MISSING_ID)).toBeUndefined()
  })

  it('refuses a dangling canonical alias without migrating its surviving legacy row', () => {
    const context = openStore()
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })
    const tables = context.fixture.snapshot()
    tables.worktreeMetaByIdentity = {}
    context.fixture.replaceTables(tables)

    expectRejected(context, WORKTREE_ID, { executionHostId: 'local', instanceId: LOCAL_INSTANCE })
  })

  it('updates only the exact host and instance and refuses mutation payload identity changes', () => {
    const context = openStore(['local', REMOTE_HOST])
    const local = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      comment: 'Local comment'
    })
    context.store.setWorktreeMetaForHost(WORKTREE_ID, REMOTE_HOST, {
      instanceId: REMOTE_INSTANCE,
      comment: 'Remote comment'
    })
    const remoteExpectation = { executionHostId: REMOTE_HOST, instanceId: REMOTE_INSTANCE }

    expect(context.store.isCurrentWorktreeMetadata(WORKTREE_ID, remoteExpectation)).toBe(true)
    expect(
      context.store.updateExistingWorktreeMeta(
        WORKTREE_ID,
        { comment: 'Remote updated' },
        remoteExpectation
      )
    ).toMatchObject({ hostId: REMOTE_HOST, instanceId: REMOTE_INSTANCE, comment: 'Remote updated' })
    expect(context.store.getWorktreeMetaForHost(WORKTREE_ID, 'local')).toEqual(local)
    expectRejected(context, WORKTREE_ID, {
      executionHostId: REMOTE_HOST,
      instanceId: LOCAL_INSTANCE
    })
    expectRejected(
      context,
      WORKTREE_ID,
      remoteExpectation,
      { instanceId: 'attempted-rotation' },
      true
    )
    expectRejected(context, WORKTREE_ID, remoteExpectation, { hostId: 'local' }, true)
  })

  it('refuses ambiguous same-host aliases even when an expected instance matches one candidate', () => {
    const context = openStore()
    const first = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      comment: 'First occupant'
    })
    const second: WorktreeMeta = { ...first, instanceId: 'second-instance', lastActivityAt: 1 }
    const tables = context.fixture.snapshot()
    const firstKey = identityKey('local', LOCAL_INSTANCE)
    const secondKey = identityKey('local', 'second-instance')
    tables.worktreeMetaByIdentity = { [firstKey]: first, [secondKey]: second }
    tables.worktreeIdentityAliases = {
      [composeWorktreeHostIdentity('local', WORKTREE_ID)]: [firstKey, secondKey]
    }
    context.fixture.replaceTables(tables)

    expectRejected(context, WORKTREE_ID, { executionHostId: 'local', instanceId: LOCAL_INSTANCE })
  })

  it('refuses unqualified mutations when the repo and locator have multiple host owners', () => {
    const context = openStore(['local', REMOTE_HOST])
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })
    context.store.setWorktreeMetaForHost(WORKTREE_ID, REMOTE_HOST, { instanceId: REMOTE_INSTANCE })

    expectRejected(context, WORKTREE_ID, {})
    expectRejected(context, WORKTREE_ID, { instanceId: LOCAL_INSTANCE })
  })

  it.each<ExecutionHostId>(['local', REMOTE_HOST])(
    'backfills a hostless legacy row only for its unique owner %s',
    (hostId) => {
      const context = openStore([hostId])
      const legacy = structuredClone(
        context.store.setWorktreeMetaForHost(WORKTREE_ID, hostId, {
          comment: 'Legacy comment'
        })
      )
      delete legacy.hostId
      delete legacy.instanceId
      context.fixture.replaceTables({
        worktreeMeta: { [WORKTREE_ID]: legacy },
        worktreeMetaByIdentity: {},
        worktreeIdentityAliases: {}
      })

      expectRejected(context, WORKTREE_ID, {
        executionHostId: hostId,
        instanceId: 'unproven-instance'
      })
      expect(
        context.store.isCurrentWorktreeMetadata(WORKTREE_ID, { executionHostId: hostId })
      ).toBe(true)
      const migrated = context.store.updateExistingWorktreeMeta(
        WORKTREE_ID,
        { comment: 'After migration' },
        { executionHostId: hostId }
      )
      expect(migrated).toMatchObject({ hostId, comment: 'After migration' })
      expect(migrated?.instanceId).toBeTruthy()
      if (!migrated?.instanceId) {
        throw new Error('Legacy instance was not backfilled')
      }
      const repeated = context.store.updateExistingWorktreeMeta(
        WORKTREE_ID,
        { isUnread: true },
        { executionHostId: hostId, instanceId: migrated.instanceId }
      )
      expect(repeated?.instanceId).toBe(migrated.instanceId)
      expect(context.fixture.snapshot().worktreeIdentityAliases).toEqual({
        [composeWorktreeHostIdentity(hostId, WORKTREE_ID)]: [
          identityKey(hostId, migrated.instanceId)
        ]
      })
    }
  )

  it('does not let a unique SSH repo claim hostless legacy metadata owned by a local canonical alias', () => {
    const context = openStore([REMOTE_HOST])
    const local = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      comment: 'Local comment'
    })
    const legacy = { ...local }
    delete legacy.hostId
    const tables = context.fixture.snapshot()
    tables.worktreeMeta = { [WORKTREE_ID]: legacy }
    context.fixture.replaceTables(tables)

    expectRejected(context, WORKTREE_ID, {
      executionHostId: REMOTE_HOST,
      instanceId: LOCAL_INSTANCE
    })
    expect(
      context.store.isCurrentWorktreeMetadata(WORKTREE_ID, {
        executionHostId: 'local',
        instanceId: LOCAL_INSTANCE
      })
    ).toBe(true)
  })

  it('keeps registration and discovery setters able to create and deliberately rotate instances', () => {
    const context = openStore()
    expect(context.store.isCurrentWorktreeMetadata(WORKTREE_ID, { executionHostId: 'local' })).toBe(
      false
    )
    const first = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      displayName: 'Discovered'
    })
    expect(first.instanceId).toBeTruthy()
    const rotated = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: 'rotated-instance'
    })
    expect(rotated.instanceId).toBe('rotated-instance')

    expectRejected(context, WORKTREE_ID, { executionHostId: 'local', instanceId: first.instanceId })
    expect(
      context.store.updateExistingWorktreeMeta(
        WORKTREE_ID,
        { comment: 'Current occupant' },
        { executionHostId: 'local', instanceId: rotated.instanceId }
      )
    ).toMatchObject({ instanceId: 'rotated-instance', comment: 'Current occupant' })
    const legacyCreated = context.store.setWorktreeMeta(MISSING_ID, {
      displayName: 'Legacy discovery'
    })
    expect(legacyCreated.instanceId).toBeTruthy()
  })

  it('refuses the old locator after a rename and preserves the canonical instance at the new locator', () => {
    const context = openStore()
    const renamedId = `${REPO_ID}::${join(tmpdir(), 'metadata-admission-renamed')}`
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })
    context.store.migrateWorktreeIdentity(WORKTREE_ID, renamedId, 'local')

    expectRejected(context, WORKTREE_ID, { executionHostId: 'local', instanceId: LOCAL_INSTANCE })
    const expectation = { executionHostId: 'local', instanceId: LOCAL_INSTANCE } as const
    expect(context.store.isCurrentWorktreeMetadata(renamedId, expectation)).toBe(true)
    expect(
      context.store.updateExistingWorktreeMeta(
        renamedId,
        { comment: 'Renamed occupant' },
        expectation
      )
    ).toMatchObject({ instanceId: LOCAL_INSTANCE, comment: 'Renamed occupant' })
    expect(context.fixture.snapshot().worktreeIdentityAliases).toEqual({
      [composeWorktreeHostIdentity('local', renamedId)]: [identityKey('local', LOCAL_INSTANCE)]
    })
  })

  it('documents that an identity-less delayed legacy write can still update a re-added occupant', () => {
    const context = openStore()
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })
    context.store.removeWorktreeMeta(WORKTREE_ID, 'local')
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: 'new-instance',
      comment: 'New comment'
    })

    expectRejected(context, WORKTREE_ID, { executionHostId: 'local', instanceId: LOCAL_INSTANCE })
    // Legacy callers supply no occupant identity, so presence alone cannot fence a delayed write.
    expect(
      context.store.updateExistingWorktreeMeta(WORKTREE_ID, { comment: 'Delayed legacy comment' })
    ).toMatchObject({ instanceId: 'new-instance', comment: 'Delayed legacy comment' })
  })
})

describe.each(['runtime', 'desktop'] as const)('%s sort metadata admission', (entrypoint) => {
  it('leaves metadata, aliases and persistence untouched when every requested id is absent', () => {
    const context = openStore()
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })

    expectSortUnchanged(context, entrypoint, [MISSING_ID, MISSING_ID])
    expect(context.store.getWorktreeMeta(MISSING_ID)).toBeUndefined()
  })

  it('does not repair a dangling alias while planning a rank for its surviving legacy row', () => {
    const context = openStore()
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', { instanceId: LOCAL_INSTANCE })
    const tables = context.fixture.snapshot()
    tables.worktreeMetaByIdentity = {}
    tables.worktreeMeta[WORKTREE_ID].sortOrder = 0
    delete tables.worktreeMeta[WORKTREE_ID].hostId
    delete tables.worktreeMeta[WORKTREE_ID].instanceId
    context.fixture.replaceTables(tables)

    expectSortUnchanged(context, entrypoint, [WORKTREE_ID, MISSING_ID])
  })

  it('preserves competing aliases on the same host rather than assigning a rank', () => {
    const context = openStore()
    const first = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      sortOrder: undefined
    })
    const second = { ...first, instanceId: 'second-instance', lastActivityAt: 1 }
    const tables = context.fixture.snapshot()
    const firstKey = identityKey('local', LOCAL_INSTANCE)
    const secondKey = identityKey('local', 'second-instance')
    tables.worktreeMetaByIdentity = { [firstKey]: first, [secondKey]: second }
    tables.worktreeIdentityAliases = {
      [composeWorktreeHostIdentity('local', WORKTREE_ID)]: [firstKey, secondKey]
    }
    context.fixture.replaceTables(tables)

    expectSortUnchanged(context, entrypoint, [WORKTREE_ID, MISSING_ID])
  })

  it('leaves both hosts untouched when a locator has multiple metadata owners', () => {
    const context = openStore(['local', REMOTE_HOST])
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      sortOrder: undefined
    })
    context.store.setWorktreeMetaForHost(WORKTREE_ID, REMOTE_HOST, {
      instanceId: REMOTE_INSTANCE,
      sortOrder: undefined
    })

    expectSortUnchanged(context, entrypoint, [WORKTREE_ID, MISSING_ID])
  })

  it('updates only the live row and durably preserves its occupant and aliases', async () => {
    const context = openStore()
    const live = context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      sortOrder: undefined
    })
    context.fixture.persisted()
    const before = context.fixture.snapshot()
    const generation = context.fixture.writeGeneration()
    vi.spyOn(Date, 'now').mockReturnValue(9_000)

    persistSortOrder(context.store, entrypoint, [MISSING_ID, WORKTREE_ID, MISSING_ID], 1)

    const expected = { ...live, sortOrder: 9_000 }
    expect(context.fixture.snapshot()).toEqual({
      ...before,
      worktreeMeta: { [WORKTREE_ID]: expected },
      worktreeMetaByIdentity: { [identityKey('local', LOCAL_INSTANCE)]: expected }
    })
    expect(context.fixture.writeGeneration()).toBe(generation + 1)
    expect(context.store.getWorktreeMeta(MISSING_ID)).toBeUndefined()
    await context.store.flushPendingOrThrowAsync()
    const reopened = createSqliteTestStore(Store, { dataFile: context.dataFile })
    expect(reopened.getWorktreeMeta(WORKTREE_ID)).toEqual(expected)
    expect(reopened.getWorktreeMeta(MISSING_ID)).toBeUndefined()
    expect(metadataAdmissionFixture(reopened, context.dataFile).snapshot()).toEqual(
      context.fixture.snapshot()
    )
  })

  it('does not schedule persistence for already ranked live rows mixed with an absent id', () => {
    const context = openStore()
    const secondId = `${REPO_ID}::${join(tmpdir(), 'metadata-admission-second')}`
    context.store.setWorktreeMetaForHost(WORKTREE_ID, 'local', {
      instanceId: LOCAL_INSTANCE,
      sortOrder: 200
    })
    context.store.setWorktreeMetaForHost(secondId, 'local', {
      instanceId: 'second-instance',
      sortOrder: 100
    })

    expectSortUnchanged(context, entrypoint, [WORKTREE_ID, MISSING_ID, secondId])
  })
})
