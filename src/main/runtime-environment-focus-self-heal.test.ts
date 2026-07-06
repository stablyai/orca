import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../shared/types'
import type { KnownRuntimeEnvironment } from '../shared/runtime-environments'
import {
  clearActiveRuntimeEnvironmentFocusIfMatches,
  selfHealRuntimeEnvironmentFocus
} from './runtime-environment-focus-self-heal'

function environment(
  id: string,
  source?: KnownRuntimeEnvironment['source']
): KnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    ...(source ? { source } : {}),
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:6768',
        deviceToken: 'token',
        publicKeyB64: 'key'
      }
    ],
    preferredEndpointId: `ws-${id}`
  }
}

function makeStore(activeRuntimeEnvironmentId: string | null | undefined) {
  const settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> = {}
  if (activeRuntimeEnvironmentId !== undefined) {
    settings.activeRuntimeEnvironmentId = activeRuntimeEnvironmentId
  }
  const updateSettings = vi.fn((updates: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>) => {
    settings.activeRuntimeEnvironmentId = updates.activeRuntimeEnvironmentId
    return settings
  })
  return {
    store: {
      getSettings: () => settings,
      updateSettings
    },
    updateSettings
  }
}

describe('runtime environment focus self-heal', () => {
  it('keeps a focus id that resolves to a user-managed environment', () => {
    const { store, updateSettings } = makeStore('env-1')

    selfHealRuntimeEnvironmentFocus({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => [environment('env-1')]
    })

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('clears a dangling focus id and logs one diagnostic line', () => {
    const { store, updateSettings } = makeStore('missing-env')
    const log = vi.fn()

    selfHealRuntimeEnvironmentFocus({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => [environment('env-1')],
      log
    })

    expect(updateSettings).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: null })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('missing-env')
  })

  it('clears an ephemeral-VM focus id after restart', () => {
    const { store, updateSettings } = makeStore('vm-env')
    const log = vi.fn()

    selfHealRuntimeEnvironmentFocus({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => [environment('vm-env', 'ephemeral-vm')],
      log
    })

    expect(updateSettings).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: null })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('leaves null and absent focus settings untouched', () => {
    const nullCase = makeStore(null)
    const absentCase = makeStore(undefined)
    const listKnownEnvironments = vi.fn(() => [environment('env-1')])

    selfHealRuntimeEnvironmentFocus({
      store: nullCase.store,
      userDataPath: '/user-data',
      listKnownEnvironments
    })
    selfHealRuntimeEnvironmentFocus({
      store: absentCase.store,
      userDataPath: '/user-data',
      listKnownEnvironments
    })

    expect(nullCase.updateSettings).not.toHaveBeenCalled()
    expect(absentCase.updateSettings).not.toHaveBeenCalled()
    expect(listKnownEnvironments).not.toHaveBeenCalled()
  })

  it('normalizes an empty persisted id to null without reading the registry', () => {
    const { store, updateSettings } = makeStore('')
    const listKnownEnvironments = vi.fn(() => [environment('env-1')])

    selfHealRuntimeEnvironmentFocus({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments
    })

    expect(updateSettings).toHaveBeenCalledWith({ activeRuntimeEnvironmentId: null })
    expect(listKnownEnvironments).not.toHaveBeenCalled()
  })

  it('fails soft when the registry cannot be read', () => {
    const { store, updateSettings } = makeStore('env-1')

    selfHealRuntimeEnvironmentFocus({
      store,
      userDataPath: '/user-data',
      listKnownEnvironments: () => {
        throw new Error('invalid registry')
      }
    })

    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('clears the active focus on matching in-process removal with listener notification', () => {
    const { store, updateSettings } = makeStore('env-1')

    clearActiveRuntimeEnvironmentFocusIfMatches(store, 'env-1')

    expect(updateSettings).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: null },
      { notifyListeners: true }
    )
  })
})
