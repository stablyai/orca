import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderRelaySpool } from '../provider-relay-spool'

describe('provider relay spool', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-spool-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('replays every unacked line once, in seq order, across detach and reattach, then frees the file', async () => {
    const path = join(dir, 'r.ndjson')
    const delivered: string[] = []
    const spool = new ProviderRelaySpool({
      path,
      deliver: (record) => delivered.push(`${record.seq}:${record.line}`),
      onPressureChanged: () => {}
    })
    await spool.attach(0)
    spool.append('a')
    spool.append('b')
    spool.append('c')
    spool.ack(2)
    await spool.detach()
    spool.append('d')
    spool.append('e')
    await spool.detach()
    expect(existsSync(path)).toBe(true)
    delivered.length = 0

    expect(await spool.attach(1)).toBe(5)
    spool.append('f')
    expect(delivered).toEqual(['3:c', '4:d', '5:e', '6:f'])

    spool.ack(6)
    await spool.detach()
    expect(spool.drained).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('pauses the agent at the detached cap and resumes once a client attaches, never dropping a line', async () => {
    const pressure: boolean[] = []
    const delivered: number[] = []
    const spool = new ProviderRelaySpool({
      path: join(dir, 'r.ndjson'),
      deliver: (record) => delivered.push(record.seq),
      onPressureChanged: (paused) => pressure.push(paused),
      fileCapBytes: 100
    })
    for (let i = 0; i < 5; i++) {
      spool.append('x'.repeat(30))
    }
    expect(pressure).toEqual([true])
    await spool.attach(0)
    expect(delivered).toEqual([1, 2, 3, 4, 5])
    spool.ack(5)
    await spool.detach()
    expect(pressure).toEqual([true, false])
  })
})
