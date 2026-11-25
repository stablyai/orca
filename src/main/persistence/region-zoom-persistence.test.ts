import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState, writeDataFile } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('keeps the legacy sidebar scale across a panel-only edit and restart', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-region-zoom-'))
  writeDataFile({ schemaVersion: 1, ui: { uiZoomLevel: 1.5 } })
  const store = createStore()
  expect(store.getUI()).toMatchObject({ uiZoomLevel: 1.5, sidebarZoomLevel: 1.5 })

  store.updateUI({ uiZoomLevel: 2 })
  await store.flushAsync()
  await closeTestStores()

  expect(createStore().getUI()).toMatchObject({ uiZoomLevel: 2, sidebarZoomLevel: 1.5 })
})
