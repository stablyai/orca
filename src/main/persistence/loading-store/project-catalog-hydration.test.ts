/**
 * An unhydrated store answers `[]` from every project collection, which reads exactly like
 * "nothing is configured" — and the Claude home-binding decision refuses rather than launch the
 * shared home for a group that bound another one. Drives the real `Store` because the question is
 * whether a store can ever be observed before its profile state is loaded.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const stores: InstanceType<typeof Store>[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.flush()
  }
})

describe('project catalog hydration', () => {
  it('reports hydrated from the first observable moment of a new store', () => {
    const store = new Store({
      dataFile: join(mkdtempSync(join(tmpdir(), 'orca-catalog-hydration-')), 'state.json')
    })
    stores.push(store)

    expect(store.hasHydratedProjectCatalog()).toBe(true)
    expect(store.getProjectGroups()).toEqual([])
  })
})
