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
    writer.tick('reserve')
    writer.tick('db')
    expect(writes).toEqual(['reserve'])
    await settle()
    writer.tick('db')
    await settle()
    writer.tick('db')
    expect(writes).toEqual(['reserve', 'db'])
    clock.value += CELL_ADMIT_EFFECTIVE_REFRESH_MS
    writer.tick('db')
    expect(writes).toEqual(['reserve', 'db', 'db'])
  })

  it('takes no connection while requests wait for the pool', () => {
    const { writes, writer } = setup({ busy: true })
    writer.tick('db')
    expect(writes).toEqual([])
  })

  // Best-effort: a failed write never throws into the cell, logs at most once a minute, and retries.
  it('retries a failed write on the next tick and rate-limits its log line', async () => {
    const { clock, writes, logs, writer, settle } = setup({ fail: true })
    writer.tick('db')
    await settle()
    clock.value += 1_000
    writer.tick('db')
    await settle()
    expect(writes).toEqual(['db', 'db'])
    expect(logs).toHaveLength(1)
    expect(JSON.parse(logs[0]!)).toMatchObject({ event: 'orca_relay_cell_admit_effective_write_failed', mode: 'db' })
  })
})
