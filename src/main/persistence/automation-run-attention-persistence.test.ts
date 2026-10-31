import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createStore,
  dataFile,
  readPersistedState,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { buildProfileStateCutoverFixture } from './profile-state-cutover-fixture'
import { Store } from './loading-store/store'
import { createAutomationRunWriter } from '../automations/automation-run-writer'
import { ProfileStateSqliteAuthority } from './profile-state/profile-state-sqlite-authority'
import { prepareLegacyProfileState } from './profile-state/legacy-json/profile-state-legacy-import'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-attention-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('automation failure seen activation', () => {
  it('activates fresh defaults before the first failure and preserves it unseen on restart', async () => {
    const store = createStore()
    await store.flushPendingOrThrowAsync()
    expect(readPersistedState().automationFailureSeenVersion).toBe(1)
    const fixture = buildProfileStateCutoverFixture()
    store.addRepo(fixture.repos[0])
    const automation = store.createAutomation({
      ...fixture.automations[0],
      projectId: fixture.repos[0].id
    })
    const run = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
    store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed' })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    const reopened = createStore()
    const retained = reopened.listAutomationRuns().find((row) => row.id === run.id)
    expect(retained?.status).toBe('dispatch_failed')
    expect(retained?.failureSeenAt).toBeUndefined()
  })

  it('commits the legacy receipt and seen marks together, without reseeding later failures', async () => {
    const source = buildProfileStateCutoverFixture(testState.dir)
    source.automationRuns[0].status = 'dispatch_failed'
    writeDataFile(source)
    const store = createStore()
    await store.flushPendingOrThrowAsync()
    const persisted = readPersistedState()
    expect(persisted.automationFailureSeenVersion).toBe(1)
    expect(persisted.automationRuns[0].failureSeenAt).toEqual(expect.any(Number))
    const run = store.createAutomationRun(store.listAutomations()[0], 1_800_000_000_000, 'manual')
    store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed' })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    expect(
      createStore()
        .listAutomationRuns()
        .find((row) => row.id === run.id)?.failureSeenAt
    ).toBeUndefined()
  })

  it('preserves current unseen rows through export and frozen import without changing its source', async () => {
    const source = buildProfileStateCutoverFixture(testState.dir)
    source.automationFailureSeenVersion = 1
    source.automationRuns[0].status = 'dispatch_failed'
    writeDataFile(source)
    const store = createStore()
    await store.flushPendingOrThrowAsync()
    const exported = store.prepareProfileStateExport().json
    const snapshot = join(testState.dir, 'import-source.json')
    writeFileSync(snapshot, exported)
    const persistedBefore = readPersistedState()
    const imported = new Store({
      dataFile: snapshot,
      serializedState: readFileSync(snapshot, 'utf8')
    })
    try {
      expect(imported.listAutomationRuns()[0].failureSeenAt).toBeUndefined()
      expect(
        JSON.parse(imported.prepareProfileStateExport().json).automationFailureSeenVersion
      ).toBe(1)
      expect(readFileSync(snapshot, 'utf8')).toBe(exported)
      expect(readPersistedState()).toEqual(persistedBefore)
    } finally {
      await imported.freezeWritesAsync()
    }
    expect(dataFile()).not.toBe(snapshot)
  })
})

it('acknowledges only one retained failed row, survives restart, and deletes the mark with its automation', async () => {
  const source = buildProfileStateCutoverFixture(testState.dir)
  source.automationFailureSeenVersion = 1
  source.automationRuns = []
  writeDataFile(source)
  const store = createStore()
  const automation = store.listAutomations()[0]
  const first = store.createAutomationRun(automation, 1_800_000_000_000, 'manual')
  const second = store.createAutomationRun(automation, 1_800_000_000_000 + 1, 'manual')
  const success = store.createAutomationRun(automation, 1_800_000_000_000 + 2, 'manual')
  expect(store.markAutomationRunSeen(automation.id, first.id)).toBe(false)
  store.updateAutomationRun({ runId: first.id, status: 'dispatch_failed' })
  store.updateAutomationRun({ runId: second.id, status: 'dispatch_failed' })
  store.updateAutomationRun({ runId: success.id, status: 'completed' })
  expect(
    store.listAutomationsForScope().items.find((item) => item.automationId === automation.id)
      ?.unseenFailureCount
  ).toBe(2)
  expect(store.markAutomationRunSeen(automation.id, first.id)).toBe(true)
  expect(
    store.listAutomationsForScope().items.find((item) => item.automationId === automation.id)
      ?.unseenFailureCount
  ).toBe(1)
  const seenAt = store
    .listAutomationRuns(automation.id)
    .find((row) => row.id === first.id)?.failureSeenAt
  expect(store.markAutomationRunSeen(automation.id, first.id)).toBe(true)
  expect(
    store.listAutomationRuns(automation.id).find((row) => row.id === first.id)?.failureSeenAt
  ).toBe(seenAt)
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  const reopened = createStore()
  const runs = reopened.listAutomationRuns(automation.id)
  expect(runs.find((row) => row.id === first.id)?.failureSeenAt).toEqual(expect.any(Number))
  expect(runs.find((row) => row.id === second.id)?.failureSeenAt).toBeUndefined()
  reopened.deleteAutomation(automation.id)
  expect(reopened.listAutomationRuns(automation.id)).toEqual([])
  expect(reopened.markAutomationRunSeen(automation.id, first.id)).toBe(false)
})

it('carries a legacy frozen activation into its destination and preserves the sync first-full-write obligation after failure', async () => {
  const source = buildProfileStateCutoverFixture(testState.dir)
  delete source.automationFailureSeenVersion
  source.automationRuns[0].status = 'dispatch_failed'
  const original = JSON.stringify(source)
  const path = join(testState.dir, 'legacy-source.json')
  writeFileSync(path, original)
  const prepared = prepareLegacyProfileState(path, original).prepared.json
  expect(readFileSync(path, 'utf8')).toBe(original)
  const imported = JSON.parse(prepared)
  expect(imported.automationFailureSeenVersion).toBe(1)
  expect(imported.automationRuns[0].failureSeenAt).toEqual(expect.any(Number))
  const authority = new ProfileStateSqliteAuthority(
    join(testState.dir, 'destination.db'),
    'attention-destination'
  )
  authority.writeSerializedState(Buffer.from(original))
  const store = new Store({
    dataFile: join(testState.dir, 'destination.json'),
    profileStateAuthority: authority
  })
  try {
    const first = vi
      .spyOn(authority, 'writeCompleteSerializedDomains')
      .mockImplementationOnce(() => {
        throw new Error('first complete write failed')
      })
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('first complete write failed')
    expect(
      JSON.parse(authority.readSerializedState()!).automationFailureSeenVersion
    ).toBeUndefined()
    const newer = store.createAutomationRun(store.listAutomations()[0], 1_800_000_000_010, 'manual')
    store.updateAutomationRun({ runId: newer.id, status: 'dispatch_failed' })
    await store.flushPendingOrThrowAsync()
    const disk = JSON.parse(authority.readSerializedState()!)
    expect(first).toHaveBeenCalled()
    expect(disk.automationFailureSeenVersion).toBe(1)
    expect(
      disk.automationRuns.find((row: { id: string }) => row.id === source.automationRuns[0].id)
        .failureSeenAt
    ).toEqual(expect.any(Number))
    expect(
      disk.automationRuns.find((row: { id: string }) => row.id === newer.id).failureSeenAt
    ).toBeUndefined()
    store.freezeWrites()
    const destination = new ProfileStateSqliteAuthority(
      join(testState.dir, 'imported.db'),
      'attention-import'
    )
    destination.writeSerializedState(Buffer.from(prepared))
    const loaded = new Store({
      dataFile: join(testState.dir, 'imported.json'),
      profileStateAuthority: destination
    })
    expect(loaded.listAutomationRuns()[0].failureSeenAt).toBe(
      imported.automationRuns[0].failureSeenAt
    )
    loaded.freezeWrites()
  } finally {
    await store.freezeWritesAsync()
  }
})

it('rechecks actual synchronous primary durability when commit precedes outcome installation', async () => {
  const source = buildProfileStateCutoverFixture(testState.dir)
  source.automationRuns[0].status = 'dispatched'
  writeDataFile(source)
  const store = createStore()
  await store.flushPendingOrThrowAsync()
  const update = store.updateAutomationRunWithTransition.bind(store)
  vi.spyOn(store, 'updateAutomationRunWithTransition').mockImplementation((result) => {
    const transition = update(result)
    store.flushOrThrow()
    expect(store.automationDurableWriteGeneration()).toBe(store.automationWriteGeneration())
    return transition
  })
  const publish = vi.fn()
  const writer = createAutomationRunWriter(store, publish)
  await writer.updateRun({ runId: source.automationRuns[0].id, status: 'completed' })
  expect(
    readPersistedState().automationRuns.find((run) => run.id === source.automationRuns[0].id)
      ?.status
  ).toBe('completed')
  expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(1)
  store.updateSettings({ theme: 'dark' })
  await store.flushPendingOrThrowAsync()
  expect(publish.mock.calls.filter(([event]) => event.settledRun)).toHaveLength(1)
  writer.dispose()
})
