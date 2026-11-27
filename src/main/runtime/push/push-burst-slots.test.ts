import { describe, expect, it } from 'vitest'
import { PushBurstSlots } from './push-burst-slots'

describe('PushBurstSlots', () => {
  it('releases stale coverage and admits a new push after the clock moves backwards', async () => {
    const slots = new PushBurstSlots()
    const slot = slots.reserve('phone', 'subject', 60_000)
    if (!slot) {
      throw new Error('the first push must hold its slot')
    }
    slots.recordDelivery(slot, Promise.resolve('digest'))
    const devices = [{ deviceId: 'phone', pushRegistration: { tokenDigest: 'digest' } }]
    const request = { subject: 'subject', tokenDigests: ['digest'] }
    expect(await slots.coveredDigests(devices, request, 61_000)).toEqual(['digest'])
    expect(await slots.coveredDigests(devices, request, 1_000)).toEqual([])
    expect(slots.reserve('phone', 'subject', 1_000)).not.toBeNull()
    expect(slots.reserve('phone', 'subject', 1_001)).toBeNull()
    expect(slots.reserve('phone', 'subject', 6_000)).not.toBeNull()
  })
})
