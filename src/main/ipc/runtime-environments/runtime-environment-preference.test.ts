import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment
} from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import type { Store } from '../../persistence/loading-store/store'
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
      // Each saved server needs a distinct key; duplicate keys are rejected.
      publicKeyB64: Buffer.alloc(32, name).toString('base64')
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
})
