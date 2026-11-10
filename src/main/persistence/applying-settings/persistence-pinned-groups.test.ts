import { closeTestStores, testState, createStore, readDataFile } from '../persistence-test-harness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-pin-groups-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('persists and hydrates pin groups, host membership and collapsed groups across reloads', async () => {
  const store = await createStore()
  store.updateSettings({
    pinnedGroups: [{ id: 'fleet', name: 'Fleet', order: 2 }],
    pinnedGroupByWorktreeIdentity: { 'local|a': 'fleet', 'runtime:orion|a': 'fleet' }
  })
  store.updateUI({ collapsedGroups: ['pinned-group:fleet'] })
  store.flush()
  expect(readDataFile()).toMatchObject({
    settings: {
      pinnedGroups: [{ id: 'fleet', name: 'Fleet', order: 2 }],
      pinnedGroupByWorktreeIdentity: { 'local|a': 'fleet', 'runtime:orion|a': 'fleet' }
    }
  })
  await closeTestStores()
  const reopened = await createStore()
  expect(reopened.getSettings()).toMatchObject({
    pinnedGroups: [{ id: 'fleet', name: 'Fleet', order: 2 }],
    pinnedGroupByWorktreeIdentity: { 'local|a': 'fleet', 'runtime:orion|a': 'fleet' }
  })
  expect(reopened.getUI().collapsedGroups).toEqual(['pinned-group:fleet'])
})
