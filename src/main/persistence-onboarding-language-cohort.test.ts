import {
  closeTestStores,
  createStore,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof crypto>()),
  randomInt: vi.fn()
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-onboarding-language-cohort-'))
})
afterEach(async () => {
  await closeTestStores()
  vi.resetAllMocks()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('persisted onboarding language cohorts', () => {
  it.each([
    { draw: 0, cohort: 'control' },
    { draw: 1, cohort: 'treatment' }
  ])('retains $cohort through settings changes and restart', async ({ draw, cohort }) => {
    vi.mocked(crypto.randomInt).mockImplementation(() => draw)
    const store = createStore()
    const telemetry = store.getSettings().telemetry
    if (!telemetry) {
      throw new Error('Fresh profile has no telemetry settings')
    }
    expect(telemetry.onboardingLanguageCohort).toBe(cohort)
    expect(store.getSettings().uiLanguage).toBe('system')
    store.flush()
    expect(readDataFile()).toHaveProperty('settings.telemetry.onboardingLanguageCohort', cohort)
    expect(readDataFile()).toHaveProperty('settings.uiLanguage', 'system')

    store.updateSettings({ uiLanguage: 'fr' })
    store.updateSettings({ telemetry: { ...telemetry, optedIn: false } })
    store.flush()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getSettings().telemetry).toEqual({ ...telemetry, optedIn: false })
    expect(reopened.getSettings().uiLanguage).toBe('fr')
    expect(crypto.randomInt).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('keeps a previously migrated profile excluded through restart', async () => {
    writeDataFile({
      settings: {
        uiLanguage: 'ja',
        telemetry: {
          optedIn: false,
          installId: 'existing-profile',
          existedBeforeTelemetryRelease: false
        }
      }
    })
    const store = createStore()
    store.flush()
    await closeTestStores()
    const reopened = createStore()
    expect(reopened.getSettings().telemetry?.onboardingLanguageCohort).toBeUndefined()
    expect(reopened.getSettings().telemetry?.optedIn).toBe(false)
    expect(reopened.getSettings().uiLanguage).toBe('ja')
    expect(crypto.randomInt).not.toHaveBeenCalled()
  })
})
