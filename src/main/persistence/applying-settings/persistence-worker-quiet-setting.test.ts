import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import { resolveWorkerQuietMinutes } from '../../../shared/orchestration/workers/worker-quiet-settings'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from '../persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('keeps user choices distinct from the product default through full saves and reload normalization', async () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-worker-quiet-'))
  for (const [raw, expected] of [
    [undefined, 7],
    [null, 7],
    [0, 0],
    [23, 23],
    [-1, 7]
  ] as const) {
    const initial = getDefaultPersistedState(testState.dir)
    writeDataFile({
      ...initial,
      settings: {
        ...initial.settings,
        ...(raw !== undefined ? { orchestrationQuietWorkerMinutes: raw } : {}),
        uiLanguagePortugueseMigrationApplied: false
      }
    })
    const store = createStore()
    store.updateSettings({ machineName: 'Quiet notice test' })
    if (raw === 23) {
      store.updateSettings({ orchestrationQuietWorkerMinutes: -2 })
      store.updateSettings({ orchestrationQuietWorkerMinutes: 1.5 })
      store.updateSettings({ orchestrationQuietWorkerMinutes: Number.MAX_SAFE_INTEGER })
    }
    store.flush()
    const exported = JSON.parse(store.prepareProfileStateExport().json)
    expect(resolveWorkerQuietMinutes(exported.settings, 7)).toBe(expected)
    expect(exported.settings.orchestrationQuietWorkerMinutes).toBe(raw)
    if (raw === undefined) {
      expect(exported.settings).not.toHaveProperty('orchestrationQuietWorkerMinutes')
    }
    await closeTestStores()
    const reopened = createStore()
    reopened.updateSettings({ machineName: 'After normalization' })
    reopened.flush()
    expect(resolveWorkerQuietMinutes(reopened.getSettings(), 7)).toBe(expected)
    expect(readPersistedState().settings.orchestrationQuietWorkerMinutes).toBe(raw)
    reopened.updateSettings({ orchestrationQuietWorkerMinutes: 0 })
    expect(resolveWorkerQuietMinutes(reopened.getSettings(), 7)).toBe(0)
    reopened.updateSettings({ orchestrationQuietWorkerMinutes: null })
    reopened.flush()
    expect(readPersistedState().settings.orchestrationQuietWorkerMinutes).toBeNull()
    expect(resolveWorkerQuietMinutes(reopened.getSettings(), 7)).toBe(7)
    await closeTestStores()
  }
})
