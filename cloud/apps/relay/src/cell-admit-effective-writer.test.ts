import { describe, expect, it } from 'vitest'
import {
  CELL_ADMIT_EFFECTIVE_REFRESH_MS,
  CellAdmitEffectiveWriter,
  DEAD_MAN_SLOT_CLAIM_RETRY_MS
} from './cell-admit-effective-writer.js'
import { DEAD_MAN_SLOT_HOLD_MS } from './cell-dead-man-trip-slot.js'

function setup(
  options: { fail?: boolean; busy?: boolean; busyWhen?: () => boolean; slotFree?: () => boolean } = {}
) {
  const clock = { value: 1_000 }
  const writes: ('db' | 'reserve' | 'claim')[] = []
  const pending: Array<() => void> = []
  const logs: string[] = []
  const writer = new CellAdmitEffectiveWriter({
    write: async (mode) => {
      writes.push(mode)
      await new Promise<void>((resolve) => pending.push(resolve))
      if (options.fail) throw new Error('connection refused')
    },
    claimTrip: async (slots) => {
      writes.push('claim')
      await new Promise<void>((resolve) => pending.push(resolve))
      return slots > 0 && (options.slotFree?.() ?? true)
    },
    databaseBusy: () => options.busy === true || options.busyWhen?.() === true,
    now: () => clock.value,
    log: (line) => logs.push(line)
  })
  const settle = async () => {
    while (pending.length > 0) pending.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { clock, writes, logs, writer, settle }
}

describe('CellAdmitEffectiveWriter', () => {
  it('writes on the first tick, on every change, and every 15 s, one write at a time', async () => {
    const { clock, writes, writer, settle } = setup()
    writer.tick('reserve', true)
    writer.tick('db', true)
    expect(writes).toEqual(['reserve'])
    await settle()
    // Tripped: the switch still says reserve, the raw mode db.
    writer.tick('db', true)
    await settle()
    writer.tick('db', true)
    expect(writes).toEqual(['reserve', 'db'])
    clock.value += CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('db', true)
    expect(writes).toEqual(['reserve', 'db', 'db'])
  })

  // Step 5 off: a db switch never writes, so the dark roll adds no database write.
  it('writes nothing while the switch has never said reserve, and one db write on the way out', async () => {
    const { clock, writes, writer, settle } = setup()
    writer.tick('db', false)
    clock.value += 10 * CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('db', false)
    expect(writes).toEqual([])
    writer.tick('reserve', true)
    await settle()
    writer.tick('reserve', false)
    await settle()
    expect(writes).toEqual(['reserve', 'db'])
    clock.value += 10 * CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('db', false)
    expect(writes).toEqual(['reserve', 'db'])
  })

  it('owes nothing more once a tripped cell already wrote db', async () => {
    const { clock, writes, writer, settle } = setup()
    writer.tick('db', true)
    await settle()
    clock.value += CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('db', false)
    writer.tick('db', false)
    expect(writes).toEqual(['db'])
  })

  it('takes no connection while requests wait for the pool', () => {
    const { writes, writer } = setup({ busy: true })
    writer.tick('db', true)
    expect(writes).toEqual([])
  })

  // Best-effort: a failed write never throws into the cell, logs at most once a minute, and retries.
  it('retries a failed write on the next tick and rate-limits its log line', async () => {
    const { clock, writes, logs, writer, settle } = setup({ fail: true })
    writer.tick('db', true)
    await settle()
    clock.value += 1_000
    writer.tick('db', true)
    await settle()
    expect(writes).toEqual(['db', 'db'])
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: 'orca_relay_cell_admit_effective_write_failed', mode: 'db' })
  })

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

  it('refreshes a tripped row past a saturated pool before its slot hold runs out', async () => {
    let busy = false
    const { clock, writes, writer, settle } = setup({ busyWhen: () => busy })
    writer.tick('db', true)
    await settle()
    busy = true
    clock.value += 4 * 60_000
    writer.tick('db', true)
    expect(writes).toEqual(['db'])
    clock.value += 60_000
    writer.tick('db', true)
    await settle()
    expect(writes).toEqual(['db', 'db'])
    expect(DEAD_MAN_SLOT_HOLD_MS).toBeGreaterThan(5 * 60_000)
  })

  it('still yields to a saturated pool for a reserve row, however old', async () => {
    let busy = false
    const { clock, writes, writer, settle } = setup({ busyWhen: () => busy })
    writer.tick('reserve', true)
    await settle()
    busy = true
    clock.value += DEAD_MAN_SLOT_HOLD_MS
    writer.tick('reserve', true)
    expect(writes).toEqual(['reserve'])
  })

  it('never claims while requests wait for the pool, or with the switch off reserve', async () => {
    const busy = setup({ busy: true })
    busy.writer.tick('reserve', true, { slots: 1, permit: () => undefined })
    expect(busy.writes).toEqual([])
    const off = setup()
    off.writer.tick('db', false, { slots: 1, permit: () => undefined })
    expect(off.writes).toEqual([])
  })
})
