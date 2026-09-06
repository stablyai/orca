import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileCellAdmissionAtStartup,
  roleOwnsAssignmentMaintenance
} from './cell-admission-startup.js'
import type { RelayCellConfig } from './config.js'

const cells: RelayCellConfig[] = [
  {
    id: 'candidate',
    url: 'https://candidate.relay.example.com',
    capacityRequests: 4_000,
    initiallyEnabled: false
  }
]

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('cell admission startup authority', () => {
  it('reserves global assignment maintenance for director-capable roles', () => {
    expect(roleOwnsAssignmentMaintenance('cell')).toBe(false)
    expect(roleOwnsAssignmentMaintenance('director')).toBe(true)
    expect(roleOwnsAssignmentMaintenance('combined')).toBe(true)
  })

  it('does not let a cell process reconcile its own admission', async () => {
    const reconcileCellsAtStartup = vi.fn()
    await reconcileCellAdmissionAtStartup({ role: 'cell', cells }, { reconcileCellsAtStartup })
    expect(reconcileCellsAtStartup).not.toHaveBeenCalled()
  })

  it.each(['director', 'combined'] as const)(
    'lets the %s process reconcile configured admission without disabling missing cells',
    async (role) => {
      const reconcileCellsAtStartup = vi.fn()
      await reconcileCellAdmissionAtStartup({ role, cells }, { reconcileCellsAtStartup })
      expect(reconcileCellsAtStartup).toHaveBeenCalledWith(cells)
    }
  )

  it('waits out transient database pressure during director startup', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const lockUnavailable = Object.assign(new Error('lock unavailable'), { code: '55P03' })
    const reconcileCellsAtStartup = vi
      .fn()
      .mockRejectedValueOnce(lockUnavailable)
      .mockRejectedValueOnce(lockUnavailable)
      .mockResolvedValue(undefined)

    const startup = reconcileCellAdmissionAtStartup(
      { role: 'director', cells },
      { reconcileCellsAtStartup }
    )
    await vi.runAllTimersAsync()
    await startup

    expect(reconcileCellsAtStartup).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_startup_reconcile_recovered')
    )
  })

  it('fails startup immediately for a permanent reconciliation error', async () => {
    const failure = new Error('invalid cell configuration')
    const reconcileCellsAtStartup = vi.fn().mockRejectedValue(failure)

    await expect(
      reconcileCellAdmissionAtStartup({ role: 'director', cells }, { reconcileCellsAtStartup })
    ).rejects.toBe(failure)
    expect(reconcileCellsAtStartup).toHaveBeenCalledTimes(1)
  })

  it('bounds transient startup retries', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const lockUnavailable = Object.assign(new Error('lock unavailable'), { code: '55P03' })
    const reconcileCellsAtStartup = vi.fn().mockRejectedValue(lockUnavailable)

    const startup = reconcileCellAdmissionAtStartup(
      { role: 'director', cells },
      { reconcileCellsAtStartup }
    )
    const rejection = expect(startup).rejects.toBe(lockUnavailable)
    await vi.runAllTimersAsync()
    await rejection

    expect(reconcileCellsAtStartup).toHaveBeenCalledTimes(20)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('orca_relay_startup_reconcile_exhausted')
    )
  })

  it('bounds retry wall time when each reconciliation is slow', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const lockUnavailable = Object.assign(new Error('lock unavailable'), { code: '55P03' })
    const reconcileCellsAtStartup = vi.fn().mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 10_000)
      throw lockUnavailable
    })

    const startup = reconcileCellAdmissionAtStartup(
      { role: 'director', cells },
      { reconcileCellsAtStartup }
    )
    const rejection = expect(startup).rejects.toBe(lockUnavailable)
    await vi.runAllTimersAsync()
    await rejection

    expect(reconcileCellsAtStartup).toHaveBeenCalledTimes(5)
  })
})
