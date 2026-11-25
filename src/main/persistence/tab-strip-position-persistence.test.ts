import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createStore, testState, writeDataFile } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

describe('tab strip position persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-tab-strip-position-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('defaults to the top strip and keeps a left choice across restart', async () => {
    const store = createStore()
    expect(store.getSettings().tabStripPosition).toBe('top')
    store.updateSettings({ tabStripPosition: 'left' })
    await store.flushAsync()
    await closeTestStores()

    expect(createStore().getSettings().tabStripPosition).toBe('left')
  })

  it('rejects unknown positions at the write and load boundaries', async () => {
    const store = createStore()
    store.updateSettings({ tabStripPosition: 'left' })
    // A value no build writes, as an older or newer profile could hold.
    store.updateSettings(JSON.parse('{"tabStripPosition":"bottom"}'))
    expect(store.getSettings().tabStripPosition).toBe('top')
    await closeTestStores()

    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: { tabStripPosition: 'sideways' },
      ui: { verticalTabListWidth: 'wide', verticalTabListCollapsed: 'yes' },
      githubCache: { pr: {}, issue: {} },
      workspaceSession: {}
    })
    const loaded = createStore()
    expect(loaded.getSettings().tabStripPosition).toBe('top')
    expect(loaded.getUI().verticalTabListWidth).toBe(240)
    expect(loaded.getUI().verticalTabListCollapsed).toBe(false)
  })

  it('clamps the vertical tab list width and persists it with the collapse', async () => {
    const store = createStore()
    store.updateUI({ verticalTabListWidth: 5000, verticalTabListCollapsed: true })
    expect(store.getUI().verticalTabListWidth).toBe(480)
    store.updateUI({ verticalTabListWidth: 12 })
    expect(store.getUI().verticalTabListWidth).toBe(160)
    store.updateUI({ verticalTabListWidth: 301.6 })
    await store.flushAsync()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getUI().verticalTabListWidth).toBe(302)
    expect(reopened.getUI().verticalTabListCollapsed).toBe(true)
  })
})
