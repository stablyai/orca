import { describe, expect, it } from 'vitest'
import {
  CELL_ADMIT_EFFECTIVE_REFRESH_MS,
  CellAdmitEffectiveWriter,
  DEAD_MAN_SLOT_CLAIM_RETRY_MS
} from './cell-admit-effective-writer.js'

function setup(
  options: { slotFree?: () => boolean } = {}
) {
  const clock = { value: 1_000 }
  const writes: ('db' | 'reserve' | 'claim')[] = []
  const pending: Array<() => void> = []
  const writer = new CellAdmitEffectiveWriter({
    write: async (mode) => {
      writes.push(mode)
      await new Promise<void>((resolve) => pending.push(resolve))
    },
    claimTrip: async (slots) => {
      writes.push('claim')
      await new Promise<void>((resolve) => pending.push(resolve))
      return slots > 0 && (options.slotFree?.() ?? true)
    },
    databaseBusy: () => false,
    now: () => clock.value
  })
  const settle = async () => {
    while (pending.length > 0) pending.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { clock, writes, writer, settle }
}

describe('CellAdmitEffectiveWriter', () => {
  it('claims a held trip slot in place of its refresh, and permits the trip only once it lands', async () => {
    let free = false
    const { clock, writes, writer, settle } = setup({ slotFree: () => free })
    let permits = 0
    const trip = { slots: 2, permit: () => (permits += 1) }
    writer.tick('reserve', true)
    // A reserve write is in flight: the claim waits for it, so it cannot land after the claim.
    writer.tick('reserve', true, trip)
    expect(writes).toEqual(['reserve'])
    await settle()
    writer.tick('reserve', true, trip)
    await settle()
    expect(writes).toEqual(['reserve', 'claim'])
    expect(permits).toBe(0)
    // Every slot taken: it keeps its reserve row fresh and asks again after the retry gap.
    clock.value += CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('reserve', true, trip)
    await settle()
    expect(writes).toEqual(['reserve', 'claim', 'reserve'])
    free = true
    clock.value += DEAD_MAN_SLOT_CLAIM_RETRY_MS - CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('reserve', true, trip)
    await settle()
    expect(writes).toEqual(['reserve', 'claim', 'reserve', 'claim'])
    expect(permits).toBe(1)
    // The claim wrote the db row, so the trip that follows writes nothing more.
    writer.tick('db', true)
    expect(writes).toEqual(['reserve', 'claim', 'reserve', 'claim'])
  })

})
