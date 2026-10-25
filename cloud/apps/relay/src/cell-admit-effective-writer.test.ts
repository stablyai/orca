import { describe, expect, it } from 'vitest'
import { CELL_ADMIT_EFFECTIVE_REFRESH_MS, CellAdmitEffectiveWriter } from './cell-admit-effective-writer.js'

function setup(options: { fail?: boolean; busy?: boolean } = {}) {
  const clock = { value: 1_000 }
  const writes: Array<'db' | 'reserve'> = []
  const pending: Array<() => void> = []
  const logs: string[] = []
  const writer = new CellAdmitEffectiveWriter({
    write: async (mode) => {
      writes.push(mode)
      await new Promise<void>((resolve) => pending.push(resolve))
      if (options.fail) throw new Error('connection refused')
    },
    databaseBusy: () => options.busy === true,
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
})
