import {
  closeTestStores,
  testState,
  createStore,
  withPlatform,
  writeDataFile,
  readDataFile
} from '../persistence-test-harness'
import { normalizeLoadedUiState } from '../loading-store/normalize-loaded-ui-state'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { ONBOARDING_FLOW_VERSION } from '../../../shared/onboarding-defaults'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('round-trips a macOS menu bar opt-out through a non-mac host unchanged', async () => {
    await withPlatform('darwin', async () => {
      const store = await createStore()
      store.updateSettings({ showMenuBarIcon: false })
      store.flush()
    })

    // Preserve macOS preferences when the same profile is opened on another platform.
    await withPlatform('win32', async () => {
      const store = await createStore()
      store.updateSettings({ minimizeToTrayOnClose: true })
      store.flush()
      expect((readDataFile() as PersistedState).settings.showMenuBarIcon).toBe(false)
    })

    await withPlatform('darwin', async () => {
      expect((await createStore()).getSettings().showMenuBarIcon).toBe(false)
    })
  })

  it('remembers hiding and restoring the Settings checklist across store reloads', async () => {
    const store = await createStore()
    const onboarding = store.getOnboarding()
    const sidebarDismissed = store.getUI().setupGuideSidebarDismissed
    expect(store.getUI().setupGuideSettingsDismissed).toBe(false)

    store.updateUI({ setupGuideSettingsDismissed: true })
    store.flush()
    await closeTestStores()

    const hidden = await createStore()
    expect(hidden.getUI().setupGuideSettingsDismissed).toBe(true)
    expect(hidden.getOnboarding()).toEqual(onboarding)
    expect(hidden.getUI().setupGuideSidebarDismissed).toBe(sidebarDismissed)
    hidden.updateUI({ setupGuideSettingsDismissed: false })
    hidden.flush()
    await closeTestStores()

    const restored = await createStore()
    expect(restored.getUI().setupGuideSettingsDismissed).toBe(false)
    expect(restored.getOnboarding()).toEqual(onboarding)
    expect(restored.getUI().setupGuideSidebarDismissed).toBe(sidebarDismissed)
  })

  it('migrates a previously dismissed onboarding checklist to the Settings preference', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: null,
        outcome: null,
        lastCompletedStep: -1,
        checklist: { dismissed: true }
      },
      ui: {}
    })

    const store = await createStore()

    expect(store.getUI().setupGuideSettingsDismissed).toBe(true)
    store.flush()
    expect(readDataFile()).toMatchObject({ ui: { setupGuideSettingsDismissed: true } })
  })

  it('preserves an explicit Settings preference over the legacy checklist dismissal', async () => {
    writeDataFile({
      onboarding: {
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: null,
        outcome: null,
        lastCompletedStep: -1,
        checklist: { dismissed: true }
      },
      ui: { setupGuideSettingsDismissed: false }
    })

    const store = await createStore()

    expect(store.getUI().setupGuideSettingsDismissed).toBe(false)
  })

  it.each(['true', 1, null, {}])(
    'persists an invalid Settings preference after normalization: %j',
    async (raw) => {
      const defaults = getDefaultPersistedState(testState.dir)
      const baselineSave = vi.fn()
      normalizeLoadedUiState(defaults, defaults, defaults.onboarding, false, false, baselineSave)
      const repairSave = vi.fn()
      const repaired = normalizeLoadedUiState(
        {
          ...defaults,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: malformed persisted values intentionally exercise load-time repair.
          ui: { ...defaults.ui, setupGuideSettingsDismissed: raw as unknown as boolean }
        },
        defaults,
        defaults.onboarding,
        false,
        false,
        repairSave
      )
      expect(repaired.setupGuideSettingsDismissed).toBe(false)
      expect(repairSave.mock.calls.length).toBeGreaterThan(baselineSave.mock.calls.length)
      const initial = await createStore()
      initial.flush()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Store just wrote this complete profile before one field is corrupted.
      const settled = readDataFile() as PersistedState
      writeDataFile({
        ...settled,
        ui: { ...settled.ui, setupGuideSettingsDismissed: raw }
      })

      const store = await createStore()
      expect(store.getUI().setupGuideSettingsDismissed).toBe(false)
      store.flush()
      expect(readDataFile()).toMatchObject({ ui: { setupGuideSettingsDismissed: false } })
    }
  )
})
