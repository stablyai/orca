import { describe, expect, it, vi } from 'vitest'
import { scheduleOrphanedMobileRelayCleanup } from './mobile-relay-orphan-cleanup'

describe('mobile relay orphan cleanup', () => {
  it('durably schedules credential deletion before removing an orphan overlay pointer', async () => {
    const order: string[] = []
    const deleteCredential = vi.fn(async () => {})
    const scheduleCleanup = vi.fn(async (hostId: string) => {
      order.push(`schedule:${hostId}`)
      return true
    })
    const removeOverlay = vi.fn(async (hostId: string) => {
      order.push(`overlay:${hostId}`)
    })

    await scheduleOrphanedMobileRelayCleanup({
      hostIds: ['host-1', 'host-1'],
      deleteCredential,
      scheduleCleanup,
      removeOverlayIfHostAbsent: removeOverlay
    })

    expect(order).toEqual(['schedule:host-1', 'overlay:host-1'])
    expect(scheduleCleanup).toHaveBeenCalledWith('host-1', deleteCredential)
  })

  it('retains the overlay pointer when cleanup intent is not durable', async () => {
    const removeOverlay = vi.fn(async () => {})
    await scheduleOrphanedMobileRelayCleanup({
      hostIds: ['host-1'],
      deleteCredential: vi.fn(async () => {}),
      scheduleCleanup: vi.fn(async () => false),
      removeOverlayIfHostAbsent: removeOverlay
    })

    expect(removeOverlay).not.toHaveBeenCalled()
  })

  it('also retains the overlay pointer when cleanup scheduling throws', async () => {
    const removeOverlay = vi.fn(async () => {})
    await scheduleOrphanedMobileRelayCleanup({
      hostIds: ['host-1'],
      deleteCredential: vi.fn(async () => {}),
      scheduleCleanup: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
      removeOverlayIfHostAbsent: removeOverlay
    })

    expect(removeOverlay).not.toHaveBeenCalled()
  })

  it('does not wait for optional overlay cleanup after intent is durable', async () => {
    const removeOverlay = vi.fn(() => new Promise<void>(() => {}))

    await expect(
      scheduleOrphanedMobileRelayCleanup({
        hostIds: ['host-1'],
        deleteCredential: vi.fn(async () => {}),
        scheduleCleanup: vi.fn(async () => true),
        removeOverlayIfHostAbsent: removeOverlay
      })
    ).resolves.toBeUndefined()
    expect(removeOverlay).toHaveBeenCalledWith('host-1')
  })
})
