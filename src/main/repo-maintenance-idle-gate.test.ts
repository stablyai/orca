import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isOnBatteryPowerMock = vi.hoisted(() => vi.fn(() => false))
const hasPendingPreparationsMock = vi.hoisted(() => vi.fn(() => false))
const hasRemovalsInFlightMock = vi.hoisted(() => vi.fn(() => false))
const setProbeMock = vi.hoisted(() => vi.fn())
const disposeMock = vi.hoisted(() => vi.fn(async () => {}))
const postponeMock = vi.hoisted(() => vi.fn())
const loadavgMock = vi.hoisted(() => vi.fn(() => [0, 0, 0]))
const appListeners = vi.hoisted(() => new Map<string, () => void>())

vi.mock('node:os', () => ({
  loadavg: loadavgMock,
  availableParallelism: () => 4
}))

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: () => void) => appListeners.set(event, listener),
    off: (event: string) => appListeners.delete(event)
  },
  powerMonitor: {
    isOnBatteryPower: isOnBatteryPowerMock
  }
}))

vi.mock('./worktree-create-preparation', () => ({
  hasPendingWorktreeCreatePreparations: hasPendingPreparationsMock
}))

vi.mock('./ipc/worktrees/worktree-ipc-context', () => ({
  hasWorktreeRemovalsInFlight: hasRemovalsInFlightMock
}))

vi.mock('./git/local-repo-maintenance', () => ({
  setRepoMaintenanceActivityProbe: setProbeMock,
  disposeLocalRepoMaintenance: disposeMock,
  postponeRepoMaintenance: postponeMock
}))

import type { RepoMaintenanceActivity } from '../shared/repo-maintenance-policy'
import { installRepoMaintenanceIdleGate } from './repo-maintenance-idle-gate'

const IDLE: RepoMaintenanceActivity = { interactive: false, constrained: false }
const INTERACTIVE: RepoMaintenanceActivity = { interactive: true, constrained: false }
const CONSTRAINED: RepoMaintenanceActivity = { interactive: false, constrained: true }

function installProbe(
  overrides: Partial<{ isQuitting: () => boolean; getWorkingAgentCount: () => number }> = {}
): { probe: () => RepoMaintenanceActivity; uninstall: () => Promise<void> } {
  const uninstall = installRepoMaintenanceIdleGate({
    isQuitting: () => false,
    getWorkingAgentCount: () => 0,
    ...overrides
  })
  const probe: unknown = setProbeMock.mock.calls.at(-1)?.[0]
  if (typeof probe !== 'function') {
    throw new Error('the gate installed no probe')
  }
  return { probe: () => probe(), uninstall }
}

beforeEach(() => {
  isOnBatteryPowerMock.mockReturnValue(false)
  hasPendingPreparationsMock.mockReturnValue(false)
  hasRemovalsInFlightMock.mockReturnValue(false)
  postponeMock.mockClear()
  loadavgMock.mockReturnValue([0, 0, 0])
  appListeners.clear()
  setProbeMock.mockClear()
  disposeMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('repo maintenance idle gate', () => {
  it('reports idle when nothing is happening', () => {
    expect(installProbe().probe()).toEqual(IDLE)
  })

  it('counts a working agent as interactive, not as a constrained machine', () => {
    // Ref maintenance waits for it; object packing, which takes no lock, does not.
    expect(installProbe({ getWorkingAgentCount: () => 3 }).probe()).toEqual(INTERACTIVE)
  })

  it('counts a worktree create in flight as interactive', () => {
    hasPendingPreparationsMock.mockReturnValue(true)

    expect(installProbe().probe()).toEqual(INTERACTIVE)
  })

  it('counts a worktree removal deleting refs as interactive', () => {
    // Removal deletes branches, and a ref deletion needs the same packed-refs lock.
    hasRemovalsInFlightMock.mockReturnValue(true)

    expect(installProbe().probe()).toEqual(INTERACTIVE)
  })

  it('counts battery power as constrained', () => {
    isOnBatteryPowerMock.mockReturnValue(true)

    expect(installProbe().probe()).toEqual(CONSTRAINED)
  })

  it('counts shutdown as constrained', () => {
    expect(installProbe({ isQuitting: () => true }).probe()).toEqual(CONSTRAINED)
  })

  it('counts a saturated CPU as constrained, and a merely busy one as not', () => {
    const { probe } = installProbe()

    loadavgMock.mockReturnValue([4, 4, 4])
    expect(probe()).toEqual(CONSTRAINED)
    loadavgMock.mockReturnValue([3.9, 8, 8])
    expect(probe()).toEqual(IDLE)
  })

  it('treats an unavailable power API as not-on-battery', () => {
    isOnBatteryPowerMock.mockImplementation(() => {
      throw new Error('unsupported')
    })

    expect(installProbe().probe()).toEqual(IDLE)
  })

  it('records user activity when the user comes back to the window', () => {
    // A focus transition, not focus itself: a window left focused while the user
    // walks away fires no event and blocks nothing.
    installProbe()

    appListeners.get('browser-window-focus')?.()

    expect(postponeMock).toHaveBeenCalledTimes(1)
  })

  it('cancels armed timers, unsubscribes, and clears the probe when uninstalled', async () => {
    await installProbe().uninstall()

    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(appListeners.has('browser-window-focus')).toBe(false)
    expect(setProbeMock).toHaveBeenLastCalledWith(null)
  })
})
