import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelaySpool } from '../provider-relay-spool'
import { replaySpoolFile } from '../provider-relay-spool-replay'

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
    await spool.dispose()
  })

  it('replays a detached line longer than a read chunk intact, multibyte characters included', async () => {
    const delivered: string[] = []
    const spool = new ProviderRelaySpool({
      path: join(dir, 'r.ndjson'),
      deliver: (record) => delivered.push(record.line),
      onPressureChanged: () => {}
    })
    const long = 'é漢'.repeat(100_000)
    spool.append('before')
    spool.append(long)
    spool.append('after')
    await spool.detach()
    await spool.attach(0)
    expect(delivered).toEqual(['before', long, 'after'])
    await spool.dispose()
  })

  it('keeps detached lines in memory when the spool file cannot be written, losing none', async () => {
    const delivered: number[] = []
    const spool = new ProviderRelaySpool({
      path: join(dir, 'missing-folder', 'r.ndjson'),
      deliver: (record) => delivered.push(record.seq),
      onPressureChanged: () => {}
    })
    spool.append('a')
    spool.append('b')
    await spool.detach()
    spool.append('c')
    await spool.detach()
    await spool.attach(0)
    expect(delivered).toEqual([1, 2, 3])
    await spool.dispose()
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
    await spool.dispose()
  })

  it('replays the whole memory tail even when an ack compacts memory mid-replay', async () => {
    const delivered: number[] = []
    let gate = false
    let release: () => void = () => {}
    const spool = new ProviderRelaySpool({
      path: join(dir, 'r.ndjson'),
      deliver: (record) => delivered.push(record.seq),
      onPressureChanged: () => {},
      drained: () =>
        gate
          ? new Promise<void>((resolve) => {
              release = resolve
            })
          : Promise.resolve(),
      memoryCapBytes: 1000
    })
    await spool.attach(0)
    for (let i = 0; i < 4; i++) {
      spool.append('x'.repeat(200))
    }
    delivered.length = 0
    gate = true
    spool.suspend()
    const replay = spool.attach(0)
    await vi.waitFor(() => expect(delivered).toEqual([1]))
    release()
    await vi.waitFor(() => expect(delivered).toEqual([1, 2]))
    spool.ack(2)
    gate = false
    release()
    await replay
    expect(delivered).toEqual([1, 2, 3, 4])
    await spool.dispose()
  })

  it('keeps lines from keepFrom on for a later attach even when the ack passes them, past the memory cap', async () => {
    const path = join(dir, 'r.ndjson')
    const delivered: number[] = []
    const spool = new ProviderRelaySpool({
      path,
      deliver: (record) => delivered.push(record.seq),
      onPressureChanged: () => {},
      memoryCapBytes: 4096
    })
    await spool.attach(0)
    for (let i = 0; i < 20; i++) {
      spool.append('x'.repeat(500))
    }
    spool.ack(20, 5)
    for (let i = 0; i < 20; i++) {
      spool.append('y'.repeat(500))
    }
    spool.ack(40, 5)
    await spool.detach()
    expect(spool.ackedSeq).toBe(4)
    delivered.length = 0

    expect(await spool.attach(spool.ackedSeq)).toBe(40)
    expect(delivered).toEqual(Array.from({ length: 36 }, (_, i) => i + 5))
    spool.ack(40)
    await spool.detach()
    expect(existsSync(path)).toBe(false)
    await spool.dispose()
  })

  it('round-trips raw spool rows of any content through the file and its compaction, and never replays a torn last row', async () => {
    const lines = [
      '',
      ' ',
      '12 34',
      '{"seq":9,"line":"x"}',
      'a\\"b\\\\n',
      'tab\there\r',
      'é😀 中',
      '7'
    ]
    const path = join(dir, 'r.ndjson')
    const delivered: string[] = []
    const spool = new ProviderRelaySpool({
      path,
      deliver: (record) => delivered.push(`${record.seq}:${record.line}`),
      onPressureChanged: () => {},
      fileCapBytes: 4096
    })
    await spool.attach(0)
    spool.append('f'.repeat(5000))
    spool.ack(1, 1)
    for (const line of lines) {
      spool.append(line, Buffer.byteLength(line))
    }
    // Releasing the first row past the cap compacts the file before the reattach reads it.
    spool.ack(lines.length + 1, 2)
    await spool.detach()
    expect(statSync(path).size).toBeLessThan(200)
    delivered.length = 0
    await spool.attach(0)
    expect(delivered).toEqual(lines.map((line, i) => `${i + 2}:${line}`))
    await spool.dispose()

    const torn = join(dir, 'torn.ndjson')
    writeFileSync(torn, '1 whole\n2 cut sho')
    const replayed: string[] = []
    const outcome = await replaySpoolFile({
      path: torn,
      after: 0,
      current: () => true,
      deliver: (record) => replayed.push(`${record.seq}:${record.line}`)
    })
    expect([outcome, replayed]).toEqual(['done', ['1:whole']])
  })
})
