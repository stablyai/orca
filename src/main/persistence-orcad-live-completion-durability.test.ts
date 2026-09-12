import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import { Store } from './persistence/loading-store/store'
import { initDataPath } from './persistence/loading-store/user-data-path'
import { liveSourceRetirementFixture } from './persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { parseOrcadMigrationSourceCutover } from '../shared/orcad-migration-source-cutover'
import * as durable from './durable-file-write'
import type { PersistedState } from '../shared/persisted-state-types'

let root = ''
const stores: Store[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-completion-durability-'))
  installFakeAppEnvironment({ getPath: () => root })
  initDataPath()
})
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
    await store.waitForPendingWrite()
  }
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = liveSourceRetirementFixture()
  const retiredAt = '2026-09-07T12:00:00.000Z'
  const completed = parseOrcadMigrationSourceCutover({
    ...f.cutover,
    phase: 'source-retired',
    updatedAt: retiredAt,
    retiredAt,
    sourceCompletion: {
      version: 1,
      retirementRecordSha256: 'a'.repeat(64),
      sourceRouteCheckpointSha256: 'b'.repeat(64)
    }
  })
  function load(filename: string, journal = f.cutover) {
    const dataFile = join(root, filename)
    writeFileSync(dataFile, JSON.stringify({ ...f.state, orcadMigrationSourceCutovers: [journal] }))
    const store = new Store({ dataFile })
    stores.push(store)
    return store
  }
  return { completed, load }
}

function installPendingJournal(store: Store, journal: ReturnType<typeof fixture>['completed']) {
  const { state } = store as unknown as { state: PersistedState }
  state.orcadMigrationSourceCutovers!.splice(0, 1, journal)
}

it('uses the actual profile dataFile and never another profile completion', () => {
  const f = fixture()
  const completedStore = f.load('custom-completed.json', f.completed)
  const pendingStore = f.load('orca-data.json')
  expect(completedStore.isOrcadLiveCompletionDurable(f.completed)).toBe(true)
  expect(pendingStore.isOrcadLiveCompletionDurable(f.completed)).toBe(false)
})

it('records a synchronous primary write and retains acknowledgment on byte-identical reflush', () => {
  const f = fixture()
  const store = f.load('profile.json')
  installPendingJournal(store, f.completed)
  expect(store.isOrcadLiveCompletionDurable(f.completed)).toBe(false)
  store.flushOrThrow()
  expect(store.isOrcadLiveCompletionDurable(f.completed)).toBe(true)
  store.flushOrThrow()
  expect(store.isOrcadLiveCompletionDurable(f.completed)).toBe(true)
})

it('does not acknowledge a failed synchronous write and retries the exact candidate', () => {
  const f = fixture()
  const store = f.load('profile.json')
  installPendingJournal(store, f.completed)
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce(() => {
    throw new Error('primary write failed')
  })
  expect(() => store.flushOrThrow()).toThrow('primary write failed')
  expect(store.isOrcadLiveCompletionDurable(f.completed)).toBe(false)
  store.flushOrThrow()
  expect(store.isOrcadLiveCompletionDurable(f.completed)).toBe(true)
})
