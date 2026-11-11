import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  reconcileCellAdmissionAtStartup
} from './cell-admission-startup.js'
import type { RelayCellConfig } from '../../config.js'

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
