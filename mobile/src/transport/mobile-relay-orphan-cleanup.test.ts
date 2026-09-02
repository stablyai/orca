import { describe, expect, it, vi } from 'vitest'
import { scheduleOrphanedMobileRelayCleanup } from './mobile-relay-orphan-cleanup'

describe('mobile relay orphan cleanup', () => {
  it('durably schedules credential deletion before removing an orphan overlay pointer', async () => {
    const order: string[] = []
    const deleteCredential = vi.fn(async () => {})
    const scheduleCleanup = vi.fn(async (hostId: string) => {
      order.push(`schedule:${hostId}`)
    })
    const removeOverlay = vi.fn(async (hostId: string) => {
      order.push(`overlay:${hostId}`)
    })

    await scheduleOrphanedMobileRelayCleanup({
      hostIds: ['host-1', 'host-1'],
      deleteCredential,
      scheduleCleanup,
      removeOverlay
    })

    expect(order).toEqual(['schedule:host-1', 'overlay:host-1'])
    expect(scheduleCleanup).toHaveBeenCalledWith('host-1', deleteCredential)
  })

  it('retains the overlay pointer when durable cleanup scheduling fails', async () => {
    const removeOverlay = vi.fn(async () => {})
    await scheduleOrphanedMobileRelayCleanup({
      hostIds: ['host-1'],
      deleteCredential: vi.fn(async () => {}),
      scheduleCleanup: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
      removeOverlay
    })

    expect(removeOverlay).not.toHaveBeenCalled()
  })
})
