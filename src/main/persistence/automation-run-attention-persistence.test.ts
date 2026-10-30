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
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
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
    const run = store.createAutomationRun(store.listAutomations()[0], Date.now(), 'manual')
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
  const first = store.createAutomationRun(automation, Date.now(), 'manual')
  const second = store.createAutomationRun(automation, Date.now() + 1, 'manual')
  const success = store.createAutomationRun(automation, Date.now() + 2, 'manual')
  expect(store.markAutomationRunSeen(automation.id, first.id)).toBe(false)
  store.updateAutomationRun({ runId: first.id, status: 'dispatch_failed' })
  store.updateAutomationRun({ runId: second.id, status: 'dispatch_failed' })
  store.updateAutomationRun({ runId: success.id, status: 'completed' })
  expect(store.markAutomationRunSeen(automation.id, first.id)).toBe(true)
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
