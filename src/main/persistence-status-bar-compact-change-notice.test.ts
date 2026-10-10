import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../shared/constants'
import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  writeDataFile
} from './persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-compact-notice-'))
})
afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function saveOlderProfile(mode: unknown): void {
  const state = getDefaultPersistedState(testState.dir)
  delete state.ui.statusBarCompactChangeNoticeDismissed
  delete state.ui.usagePercentageDisplayChangeNoticeDismissed
  if (mode === undefined) {
    delete state.ui.statusBarUsageMode
  } else {
    Reflect.set(state.ui, 'statusBarUsageMode', mode)
  }
  writeDataFile(state)
}

async function reopen(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

describe('Compact change notice persistence', () => {
  it('excludes fresh profiles on first and subsequent launches', async () => {
    const store = createStore()
    expect(store.getUI().statusBarCompactChangeNoticeDismissed).toBe(true)
    store.flush()
    expect((await reopen()).getUI().statusBarCompactChangeNoticeDismissed).toBe(true)
  })

  it.each(['verbose', 'compact'] as const)('excludes existing users who chose %s', (mode) => {
    saveOlderProfile(mode)
    const store = createStore()
    expect(store.getUI().statusBarUsageMode).toBe(mode)
    expect(store.getUI().statusBarCompactChangeNoticeDismissed).toBe(true)
  })

  it.each([undefined, null, 'expanded'])(
    'arms once when an existing saved value %j changes to Compact',
    async (mode) => {
      saveOlderProfile(mode)
      const store = createStore()
      expect(store.getUI().statusBarUsageMode).toBe('compact')
      expect(store.getUI().statusBarCompactChangeNoticeDismissed).toBe(false)
      expect(store.getUI().usagePercentageDisplayChangeNoticeDismissed).toBe(true)
      store.flush()
      expect(readDataFile()).toHaveProperty('ui.statusBarCompactChangeNoticeDismissed', false)

      const reloaded = await reopen()
      expect(reloaded.getUI().statusBarCompactChangeNoticeDismissed).toBe(false)
      reloaded.updateUI({ statusBarCompactChangeNoticeDismissed: true })
      reloaded.flush()
      expect((await reopen()).getUI().statusBarCompactChangeNoticeDismissed).toBe(true)
    }
  )
})
