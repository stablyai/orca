import { afterEach, describe, expect, it, vi } from 'vitest'

const { environments, setRetirement, disconnect } = vi.hoisted(() => ({
  environments: new Array<{ id: string; retiredAt?: string }>(),
  setRetirement: vi.fn(),
  disconnect: vi.fn()
}))
vi.mock('../../../shared/runtime-environment-store', () => ({
  listEnvironments: () => environments
}))
vi.mock('../../../shared/runtime-environment-retirement', () => ({
  setRuntimeEnvironmentRetirement: setRetirement
}))
vi.mock('../ssh/ssh-host-user-disconnect', () => ({
  disconnectRuntimeEnvironmentForUser: disconnect
}))
vi.mock('../desktop-browser-bridge-reconcile', () => ({
  requestDesktopBrowserBridgeReconcile: () => undefined,
  resetDesktopBrowserBridgeEnvironment: () => undefined
}))

import {
  clearRuntimeEnvironmentManualDisconnect,
  isRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'
import {
  liftRuntimeEnvironmentRetirement,
  restoreRetiredRuntimeEnvironments,
  retireRuntimeEnvironment
} from './runtime-environment-retirement-gate'

afterEach(() => {
  environments.length = 0
  setRetirement.mockReset()
  disconnect.mockReset()
  clearRuntimeEnvironmentManualDisconnect('env-retired')
  clearRuntimeEnvironmentManualDisconnect('env-live')
})

describe('runtime environment retirement gate', () => {
  it('persists the marker and disconnects through the user-disconnect path', () => {
    const layer = { userDataPath: '/data', invalidateTransport: vi.fn() }
    retireRuntimeEnvironment('env-retired', layer)
    expect(setRetirement).toHaveBeenCalledWith('/data', 'env-retired', expect.any(String))
    expect(disconnect).toHaveBeenCalledWith('env-retired', layer)
  })

  it('keeps retired servers undialed after a relaunch, and leaves live ones alone', () => {
    environments.push(
      { id: 'env-retired', retiredAt: '2026-10-19T00:00:00.000Z' },
      { id: 'env-live' }
    )
    restoreRetiredRuntimeEnvironments('/data')
    expect(isRuntimeEnvironmentManuallyDisconnected('env-retired')).toBe(true)
    expect(isRuntimeEnvironmentManuallyDisconnected('env-live')).toBe(false)
  })

  it('lifts the marker on an explicit Connect', () => {
    liftRuntimeEnvironmentRetirement('/data', 'env-retired')
    expect(setRetirement).toHaveBeenCalledWith('/data', 'env-retired', null)
  })
})
