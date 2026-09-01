import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isOnBatteryPowerMock = vi.hoisted(() => vi.fn(() => false))
const hasPendingPreparationsMock = vi.hoisted(() => vi.fn(() => false))
const hasRemovalsInFlightMock = vi.hoisted(() => vi.fn(() => false))
const setProbeMock = vi.hoisted(() => vi.fn())
const disposeMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ powerMonitor: { isOnBatteryPower: isOnBatteryPowerMock } }))

vi.mock('./worktree-create-preparation', () => ({
  hasPendingWorktreeCreatePreparations: hasPendingPreparationsMock
}))

vi.mock('./ipc/worktrees/worktree-ipc-context', () => ({
  hasWorktreeRemovalsInFlight: hasRemovalsInFlightMock
}))

vi.mock('./git/local-repo-ref-maintenance', () => ({
  setRepoMaintenanceActivityProbe: setProbeMock,
  disposeLocalRepoRefMaintenance: disposeMock
}))

import { installRepoMaintenanceIdleGate } from './repo-maintenance-idle-gate'

function installProbe(
  overrides: Partial<{ isQuitting: () => boolean; getWorkingAgentCount: () => number }> = {}
): { probe: () => boolean; uninstall: () => void } {
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

  it('cancels armed timers and clears the probe when uninstalled', () => {
    installProbe().uninstall()

    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(setProbeMock).toHaveBeenLastCalledWith(null)
  })
})
