import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readPersistedState,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  getLocalWorktreeScanGeneration,
  isLocalWorktreeScanGenerationCurrent
} from '../../workspaces/catalog/local-worktree-scan-generation'

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

  it('persists canonical iroh relay selection and Automatic across profile reloads', async () => {
    const store = await createStore()
    store.updateSettings({ mobileIrohRelayUrl: ' HTTPS://Relay.Example:443 ' })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const reloaded = await createStore()
    expect(reloaded.getSettings().mobileIrohRelayUrl).toBe('https://relay.example/')
    reloaded.updateSettings({ mobileIrohRelayUrl: '   ' })
    await reloaded.flushPendingOrThrowAsync()
    await closeTestStores()

    expect((await createStore()).getSettings().mobileIrohRelayUrl).toBeNull()
  })

  it.each([
    'https://private-user:private-token@relay.example/',
    'http://relay.example/',
    'https://relay.example/private',
    'https://relay.example/?private-token',
    'https://relay.example:#private-token',
    42
  ])('rejects invalid iroh relay writes without mutating the profile: %s', async (invalid) => {
    const store = await createStore()
    store.updateSettings({ mobileIrohRelayUrl: 'https://saved.example/' })
    await store.flushPendingOrThrowAsync()
    const machineName = store.getSettings().machineName
    const changed = vi.fn()
    store.onSettingsChanged(changed)

    expect(() =>
      store.updateSettings(
        // @ts-expect-error -- SAFETY: malformed runtime input must be rejected before any settings mutate.
        { mobileIrohRelayUrl: invalid, machineName: 'must-not-save' },
        { notifyListeners: true }
      )
    ).toThrowError()
    expect(store.getSettings()).toMatchObject({
      mobileIrohRelayUrl: 'https://saved.example/',
      machineName
    })
    expect(changed).not.toHaveBeenCalled()
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    expect((await createStore()).getSettings()).toMatchObject({
      mobileIrohRelayUrl: 'https://saved.example/',
      machineName
    })
  })

  it.each([
    { saved: 'https://private-user:private-token@relay.example/', expected: null },
    { saved: 'https://relay.example/private', expected: null },
    { saved: 42, expected: null },
    { saved: ' HTTPS://Relay.Example:443 ', expected: 'https://relay.example/' }
  ])('persists loaded iroh relay repair for $saved', async ({ saved, expected }) => {
    const initial = await createStore()
    await initial.flushPendingOrThrowAsync()
    await closeTestStores()
    const settled = readPersistedState()
    writeDataFile({
      ...settled,
      settings: { ...settled.settings, mobileIrohRelayUrl: saved }
    })

    vi.useFakeTimers()
    try {
      const reloaded = await createStore()
      vi.advanceTimersByTime(5000)
      await reloaded.waitForPendingWrite()
    } finally {
      vi.useRealTimers()
    }

    expect(readPersistedState().settings.mobileIrohRelayUrl).toBe(expected)
  })

  it('invalidates local worktree scans when the global Windows runtime changes', async () => {
    writeDataFile({ repos: [makeRepo()] })
    const store = await createStore()
    const generation = getLocalWorktreeScanGeneration('r1')

    store.updateSettings({ theme: 'dark' })
    expect(isLocalWorktreeScanGenerationCurrent('r1', generation)).toBe(true)

    store.updateSettings({
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(isLocalWorktreeScanGenerationCurrent('r1', generation)).toBe(false)
  })

  it('updateSettings deep-merges and clamps notification custom sound volume', async () => {
    const store = await createStore()
    store.updateSettings({
      notifications: {
        ...store.getSettings().notifications,
        enabled: false,
        customSoundPath: '/sounds/custom.wav'
      }
    })
    const updated = store.updateSettings({
      // @ts-expect-error -- Partial notification patches can arrive from older clients.
      notifications: { customSoundVolume: -20 }
    })

    expect(updated.notifications.customSoundVolume).toBe(0)
    expect(updated.notifications.enabled).toBe(false)
    expect(updated.notifications.customSoundPath).toBe('/sounds/custom.wav')
  })
})
