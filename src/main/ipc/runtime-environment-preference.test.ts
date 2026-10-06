import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment
} from '../../shared/runtime-environment-store'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Store } from '../persistence'
import {
  readSettingsWithRuntimeEnvironmentPreference,
  watchRuntimeEnvironmentPreference
} from './runtime-environment-preference'

let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-removed-preference-'))
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function preferenceStore(activeId: string | null) {
  let settings = { ...getDefaultSettings(userDataPath), activeRuntimeEnvironmentId: activeId }
  const updateSettings = vi.fn<Store['updateSettings']>((updates) => {
    settings = { ...settings, ...updates }
    return settings
  })
  return { getSettings: () => settings, updateSettings }
}

function saveEnvironment(name = 'server') {
  return addEnvironmentFromPairingCode(userDataPath, {
    name,
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:59999',
      deviceToken: 'test-token',
      publicKeyB64: Buffer.alloc(32, 1).toString('base64')
    })
  })
}

describe('Active Server after a saved host is removed', () => {
  it('survives a failed watch installation and repairs on the next settings read', () => {
    const environment = saveEnvironment()
    const store = preferenceStore(environment.id)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let stopWatching: (() => void) | undefined
    rmSync(userDataPath, { recursive: true })
    try {
      expect(() => {
        stopWatching = watchRuntimeEnvironmentPreference(store, userDataPath)
      }).not.toThrow()
      expect(store.getSettings().activeRuntimeEnvironmentId).toBe(environment.id)
      mkdirSync(userDataPath)
      writeFileSync(getEnvironmentStorePath(userDataPath), '{"version":1,"environments":[]}')
      expect(
        readSettingsWithRuntimeEnvironmentPreference(store, userDataPath).activeRuntimeEnvironmentId
      ).toBeNull()
    } finally {
      stopWatching?.()
      warning.mockRestore()
    }
  })

  it('notifies the running renderer when the CLI atomically replaces the registry', async () => {
    const environment = saveEnvironment()
    const store = preferenceStore(environment.id)
    const stopWatching = watchRuntimeEnvironmentPreference(store, userDataPath)
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      removeEnvironment(userDataPath, environment.id)
      await vi.waitFor(() => expect(store.getSettings().activeRuntimeEnvironmentId).toBeNull(), {
        timeout: 5_000
      })
      expect(store.updateSettings).toHaveBeenCalledWith(
        { activeRuntimeEnvironmentId: null },
        { notifyListeners: true }
      )
    } finally {
      stopWatching()
    }
  })

  it('repairs a CLI removal before settings can route to the deleted pairing', () => {
    const environment = saveEnvironment()
    const store = preferenceStore(environment.id)
    const before = store.getSettings()
    removeEnvironment(userDataPath, environment.id)

    const settings = readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)

    expect(settings).toEqual({ ...before, activeRuntimeEnvironmentId: null })
    expect(store.getSettings().activeRuntimeEnvironmentId).toBeNull()
    expect(store.updateSettings).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: null },
      { notifyListeners: true }
    )
    readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)
    expect(store.updateSettings).toHaveBeenCalledOnce()
  })

  it('does not select a same-name replacement or another saved server', () => {
    const removed = saveEnvironment()
    const store = preferenceStore(removed.id)
    removeEnvironment(userDataPath, removed.id)
    const replacement = saveEnvironment()
    saveEnvironment('other')

    expect(replacement.id).not.toBe(removed.id)
    expect(
      readSettingsWithRuntimeEnvironmentPreference(store, userDataPath).activeRuntimeEnvironmentId
    ).toBeNull()
  })

  it('keeps a saved host even when its endpoint is offline', () => {
    const environment = saveEnvironment()
    const store = preferenceStore(environment.id)
    const settings = store.getSettings()

    expect(readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)).toBe(settings)
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it.each(['missing', 'corrupt', 'unsupported'] as const)(
    'preserves the preference when the registry is %s',
    (kind) => {
      const environment = saveEnvironment()
      const store = preferenceStore(environment.id)
      const registryPath = getEnvironmentStorePath(userDataPath)
      if (kind === 'missing') {
        rmSync(registryPath)
      } else {
        writeFileSync(registryPath, kind === 'corrupt' ? '{' : '{"version":99,"environments":[]}')
      }

      expect(readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)).toBe(
        store.getSettings()
      )
      expect(store.updateSettings).not.toHaveBeenCalled()
    }
  )

  it('keeps local defaults without requiring a pairing registry', () => {
    const store = preferenceStore(null)
    expect(readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)).toBe(
      store.getSettings()
    )
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('does not swallow a settings write failure after confirming removal', () => {
    const environment = saveEnvironment()
    const store = preferenceStore(environment.id)
    removeEnvironment(userDataPath, environment.id)
    store.updateSettings.mockImplementation((): GlobalSettings => {
      throw new Error('settings write failed')
    })

    expect(() => readSettingsWithRuntimeEnvironmentPreference(store, userDataPath)).toThrow(
      'settings write failed'
    )
  })

  it('distinguishes a new profile from an unavailable registry for repair reads', () => {
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(() => listEnvironments(userDataPath, { requireStoreFile: true })).toThrow(
      'Could not read Orca environments'
    )
  })
})
