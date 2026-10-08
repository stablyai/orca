import {
  closeTestStores,
  createStore,
  readDataFile,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'
import type * as DefaultGlobalSettings from '../shared/default-global-settings'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
const defaults = vi.hoisted(() => ({ experimentalNativeChatOn: false }))
vi.mock('../shared/default-global-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof DefaultGlobalSettings>()
  return {
    ...actual,
    buildDefaultSettings: (...args: Parameters<typeof actual.buildDefaultSettings>) => ({
      ...actual.buildDefaultSettings(...args),
      ...(defaults.experimentalNativeChatOn ? { experimentalNativeChat: true } : {})
    })
  }
})
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

function writeSavedSettings(settings: Record<string, unknown>): void {
  const persisted = getDefaultPersistedState('/home/test')
  writeDataFile({ ...persisted, settings: { ...persisted.settings, ...settings } })
}

function writeSavedSettingsWithoutNativeChatKey(): void {
  const persisted = getDefaultPersistedState('/home/test')
  const { experimentalNativeChat: _omitted, ...settings } = persisted.settings
  void _omitted
  writeDataFile({ ...persisted, settings })
}

function persistedCohort(): unknown {
  const data = readDataFile()
  if (typeof data !== 'object' || data === null || !('settings' in data)) {
    return undefined
  }
  const { settings } = data
  return typeof settings === 'object' &&
    settings !== null &&
    'nativeChatGraduationCohort' in settings
    ? settings.nativeChatGraduationCohort
    : undefined
}

async function restart(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

describe('native chat graduation cohort persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-graduation-cohort-'))
  })

  afterEach(async () => {
    defaults.experimentalNativeChatOn = false
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('admits a profile that saved experimental native chat on, and persists it on first save', async () => {
    writeSavedSettings({ experimentalNativeChat: true })
    const store = createStore()

    expect(store.getSettings().nativeChatGraduationCohort).toBe('experimental-opt-in')
    store.flush()
    expect(persistedCohort()).toBe('experimental-opt-in')
  })

  it('excludes saved-off, missing-key, and fresh-install profiles', async () => {
    writeSavedSettings({ experimentalNativeChat: false })
    expect(createStore().getSettings().nativeChatGraduationCohort).toBe('other')
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })

    testState.dir = mkdtempSync(join(tmpdir(), 'orca-graduation-cohort-'))
    writeSavedSettingsWithoutNativeChatKey()
    expect(createStore().getSettings().nativeChatGraduationCohort).toBe('other')
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })

    testState.dir = mkdtempSync(join(tmpdir(), 'orca-graduation-cohort-'))
    const fresh = createStore()
    expect(fresh.getSettings().nativeChatGraduationCohort).toBe('other')
    fresh.flush()
    expect(persistedCohort()).toBe('other')
  })

  it('classifies from the saved file, not from defaults filled in on load', async () => {
    writeSavedSettingsWithoutNativeChatKey()
    defaults.experimentalNativeChatOn = true
    const store = createStore()

    expect(store.getSettings().experimentalNativeChat).toBe(true)
    expect(store.getSettings().nativeChatGraduationCohort).toBe('other')
  })

  it('never re-derives the cohort from the live toggle on a later launch', async () => {
    const store = createStore()
    store.flush()
    store.updateSettings({ experimentalNativeChat: true })
    store.flush()

    expect((await restart()).getSettings().nativeChatGraduationCohort).toBe('other')
  })

  it('keeps the opt-in cohort after Chat UI is turned off', async () => {
    writeSavedSettings({ experimentalNativeChat: true })
    const store = createStore()
    store.updateSettings({ experimentalNativeChat: false })
    store.flush()

    expect((await restart()).getSettings().nativeChatGraduationCohort).toBe('experimental-opt-in')
  })

  it('ignores every settings update that tries to set or clear the marker', async () => {
    const excluded = createStore()
    excluded.updateSettings({ nativeChatGraduationCohort: 'experimental-opt-in' })
    expect(excluded.getSettings().nativeChatGraduationCohort).toBe('other')
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })

    testState.dir = mkdtempSync(join(tmpdir(), 'orca-graduation-cohort-'))
    writeSavedSettings({ experimentalNativeChat: true })
    const admitted = createStore()
    admitted.updateSettings({ nativeChatGraduationCohort: undefined })
    admitted.updateSettings({ nativeChatGraduationCohort: 'other' })
    expect(admitted.getSettings().nativeChatGraduationCohort).toBe('experimental-opt-in')
  })

  it('reclassifies a malformed marker as excluded instead of reading the toggle', async () => {
    writeSavedSettings({ experimentalNativeChat: true, nativeChatGraduationCohort: 'opt-in' })
    const store = createStore()

    expect(store.getSettings().nativeChatGraduationCohort).toBe('other')
    store.flush()
    expect(persistedCohort()).toBe('other')
  })
})
