import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isOnBatteryPowerMock = vi.hoisted(() => vi.fn(() => false))
const hasPendingPreparationsMock = vi.hoisted(() => vi.fn(() => false))
const hasRemovalsInFlightMock = vi.hoisted(() => vi.fn(() => false))
const setProbeMock = vi.hoisted(() => vi.fn())
const disposeMock = vi.hoisted(() => vi.fn(async () => {}))
const interruptMock = vi.hoisted(() => vi.fn(async () => {}))
const powerListeners = vi.hoisted(() => new Map<string, () => void>())
const appListeners = vi.hoisted(() => new Map<string, () => void>())

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: () => void) => appListeners.set(event, listener),
    off: (event: string) => appListeners.delete(event)
  },
  powerMonitor: {
    isOnBatteryPower: isOnBatteryPowerMock,
    on: (event: string, listener: () => void) => powerListeners.set(event, listener),
    off: (event: string) => powerListeners.delete(event)
  }
}))

vi.mock('./worktree-create-preparation', () => ({
  hasPendingWorktreeCreatePreparations: hasPendingPreparationsMock
}))

vi.mock('./ipc/worktrees/worktree-ipc-context', () => ({
  hasWorktreeRemovalsInFlight: hasRemovalsInFlightMock
}))

vi.mock('./git/local-repo-ref-maintenance', () => ({
  setRepoMaintenanceActivityProbe: setProbeMock,
  disposeLocalRepoRefMaintenance: disposeMock,
  interruptLocalRepoRefMaintenance: interruptMock
}))

import { installRepoMaintenanceIdleGate } from './repo-maintenance-idle-gate'

function installProbe(
  overrides: Partial<{ isQuitting: () => boolean; getWorkingAgentCount: () => number }> = {}
): { probe: () => boolean; uninstall: () => Promise<void> } {
  const uninstall = installRepoMaintenanceIdleGate({
    isQuitting: () => false,
    getWorkingAgentCount: () => 0,
    ...overrides
  })
  return { probe: setProbeMock.mock.calls.at(-1)?.[0] as () => boolean, uninstall }
}

beforeEach(() => {
  isOnBatteryPowerMock.mockReturnValue(false)
  hasPendingPreparationsMock.mockReturnValue(false)
  hasRemovalsInFlightMock.mockReturnValue(false)
  interruptMock.mockClear()
  powerListeners.clear()
  appListeners.clear()
  setProbeMock.mockClear()
  disposeMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('repo maintenance idle gate', () => {
  it('reports idle when nothing is happening', () => {
    expect(installProbe().probe()).toBe(false)
  })

  it('vetoes while an agent is working', () => {
    expect(installProbe({ getWorkingAgentCount: () => 1 }).probe()).toBe(true)
  })

  it('vetoes while a worktree create is prepared or in flight', () => {
    hasPendingPreparationsMock.mockReturnValue(true)

    expect(installProbe().probe()).toBe(true)
  })

  it('vetoes while a worktree removal is deleting refs', () => {
    // Removal deletes branches, and a ref deletion needs the same packed-refs lock.
    hasRemovalsInFlightMock.mockReturnValue(true)

    expect(installProbe().probe()).toBe(true)
  })

  it('vetoes on battery power', () => {
    isOnBatteryPowerMock.mockReturnValue(true)

    expect(installProbe().probe()).toBe(true)
  })

  it('vetoes during shutdown', () => {
    expect(installProbe({ isQuitting: () => true }).probe()).toBe(true)
  })

  it('treats an unavailable power API as not-on-battery', () => {
    isOnBatteryPowerMock.mockImplementation(() => {
      throw new Error('unsupported')
    })

    expect(installProbe().probe()).toBe(false)
  })

  it('stops a running pack the moment the machine drops onto battery', () => {
    installProbe()

    powerListeners.get('on-battery')?.()

    expect(interruptMock).toHaveBeenCalledTimes(1)
  })

  it('stops a running pack the moment the user comes back to the window', () => {
    // Focus is a preemption trigger, not an admission gate: a window left
    // focused while the user walks away fires no event and blocks nothing.
    installProbe()

    appListeners.get('browser-window-focus')?.()

    expect(interruptMock).toHaveBeenCalledTimes(1)
  })

  it('cancels armed timers, unsubscribes both sources, and clears the probe when uninstalled', async () => {
    await installProbe().uninstall()

    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(powerListeners.has('on-battery')).toBe(false)
    expect(appListeners.has('browser-window-focus')).toBe(false)
    expect(setProbeMock).toHaveBeenLastCalledWith(null)
  })
})
