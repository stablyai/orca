import { describe, expect, it, vi } from 'vitest'
import type { PluginBundledBootstrapResult } from './plugin-bundled-bootstrap'
import { PluginBundledBootstrapCoordinator } from './plugin-bundled-bootstrap-coordinator'

const unchanged: PluginBundledBootstrapResult = {
  installed: [],
  unchanged: ['stablyai.orca-theme'],
  errors: []
}

describe('PluginBundledBootstrapCoordinator', () => {
  it('skips disabled requests and refreshes discovery only after publication', async () => {
    let enabled = false
    const bootstrap = vi
      .fn()
      .mockResolvedValueOnce(unchanged)
      .mockResolvedValueOnce({
        installed: ['stablyai.orca-theme'],
        unchanged: [],
        errors: []
      })
    const refreshPlugins = vi.fn().mockResolvedValue(undefined)
    const coordinator = new PluginBundledBootstrapCoordinator({
      root: 'resources',
      userDataPath: 'user-data',
      hostVersion: '1.4.0',
      isEnabled: () => enabled,
      refreshPlugins,
      bootstrap
    })

    await expect(coordinator.request()).resolves.toBeNull()
    enabled = true
    await expect(coordinator.request()).resolves.toEqual(unchanged)
    expect(refreshPlugins).not.toHaveBeenCalled()
    await coordinator.request()
    expect(refreshPlugins).toHaveBeenCalledOnce()
  })

  it('serializes overlapping startup and feature-toggle requests', async () => {
    let active = 0
    let maximumActive = 0
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const bootstrap = vi.fn(async (): Promise<PluginBundledBootstrapResult> => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (bootstrap.mock.calls.length === 1) {
        await firstGate
      }
      active -= 1
      return unchanged
    })
    const coordinator = new PluginBundledBootstrapCoordinator({
      root: 'resources',
      userDataPath: 'user-data',
      hostVersion: '1.4.0',
      isEnabled: () => true,
      refreshPlugins: vi.fn().mockResolvedValue(undefined),
      bootstrap
    })

    const first = coordinator.request()
    const second = coordinator.request()
    await vi.waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1))
    releaseFirst?.()
    await Promise.all([first, second])

    expect(bootstrap).toHaveBeenCalledTimes(2)
    expect(maximumActive).toBe(1)
  })
})
