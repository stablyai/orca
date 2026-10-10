import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable,
  writeFileDurableSync
} from './durable-file-write'

describe('durable file write', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-durable-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('durably writes a binary view without leaking bytes outside its bounds', async () => {
    const final = join(dir, 'state.gz')
    const backing = Buffer.from([99, 0x1f, 0x8b, 0, 0xff, 77])
    await writeFileDurable(`${final}.tmp`, final, backing.subarray(1, -1))
    expect(readFileSync(final)).toEqual(Buffer.from([0x1f, 0x8b, 0, 0xff]))
    expect(existsSync(`${final}.tmp`)).toBe(false)
  })

  for (const [label, write] of [
    ['async', (t: string, f: string, p: string) => writeFileDurable(t, f, p)],
    [
      'sync',
      (t: string, f: string, p: string) => {
        writeFileDurableSync(t, f, p)
        return Promise.resolve()
      }
    ]
  ] as const) {
    describe(label, () => {
      it('publishes the payload at the final path', async () => {
        const final = join(dir, 'state.json')
        await write(`${final}.tmp`, final, '{"a":1}')
        expect(readFileSync(final, 'utf-8')).toBe('{"a":1}')
      })

      it('replaces existing content atomically', async () => {
        const final = join(dir, 'state.json')
        writeFileSync(final, 'stale', 'utf-8')
        await write(`${final}.tmp`, final, 'fresh')
        expect(readFileSync(final, 'utf-8')).toBe('fresh')
      })

      it('leaves no temp file behind on success', async () => {
        const final = join(dir, 'state.json')
        const tmp = `${final}.tmp`
        await write(tmp, final, 'x')
        expect(() => readFileSync(tmp, 'utf-8')).toThrow()
      })

      it('round-trips a multi-megabyte payload without truncation', async () => {
        // Why: the real orca-data.json is large; a partial fsync would surface here.
        const final = join(dir, 'big.json')
        const payload = JSON.stringify({ blob: 'x'.repeat(4 * 1024 * 1024) })
        await write(`${final}.tmp`, final, payload)
        expect(readFileSync(final, 'utf-8')).toHaveLength(payload.length)
      })

      it('preserves exact bytes for multibyte and escape-sensitive content', async () => {
        const final = join(dir, 'utf8.json')
        const payload = JSON.stringify({ s: 'emoji 🚀 + 日本語 + \u0000 + "quotes"' })
        await write(`${final}.tmp`, final, payload)
        expect(readFileSync(final, 'utf-8')).toBe(payload)
      })

      it('surfaces an unwritable temp path instead of silently succeeding', async () => {
        const final = join(dir, 'state.json')
        const tmp = join(dir, 'missing-subdir', 'state.json.tmp')
        // The sync variant throws synchronously and the async one rejects; both must fail loudly
        // and neither may publish a partial file.
        let failed = false
        try {
          await write(tmp, final, 'x')
        } catch {
          failed = true
        }
        expect(failed).toBe(true)
        expect(() => readFileSync(final, 'utf-8')).toThrow()
      })
    })
  }

  it('keeps the last writer when async and sync paths target one file', async () => {
    const final = join(dir, 'state.json')
    await writeFileDurable(`${final}.a.tmp`, final, 'from-async')
    writeFileDurableSync(`${final}.b.tmp`, final, 'from-sync')
    expect(readFileSync(final, 'utf-8')).toBe('from-sync')
  })

  it('preserves unowned temp names and tags owned writes', () => {
    const final = join(dir, 'state.json')
    const unowned = durableWriteTempPath(final)
    const owned = durableWriteTempPath(final, 'worker-1')

    expect(unowned.startsWith(`${final}.${process.pid}.`)).toBe(true)
    expect(unowned.endsWith('.tmp')).toBe(true)
    expect(unowned).not.toContain('.owner-')
    expect(owned.startsWith(`${final}.${process.pid}.`)).toBe(true)
    expect(owned.endsWith('.owner-worker-1.tmp')).toBe(true)
  })

  it('reclaims only the retired owner in this process', async () => {
    const final = join(dir, 'state.json')
    const retired = durableWriteTempPath(final, 'worker-1')
    const replacement = durableWriteTempPath(final, 'worker-2')
    const unowned = durableWriteTempPath(final)
    const otherProcess = `${final}.${process.pid + 1}.1.test.owner-worker-1.tmp`
    const otherTarget = durableWriteTempPath(join(dir, 'other-state.json'), 'worker-1')
    const temps = [retired, replacement, unowned, otherProcess, otherTarget]
    for (const temp of temps) {
      writeFileSync(temp, 'pending')
    }
    writeFileSync(final, 'committed')

    await removeStaleDurableWriteTempFiles(final, { retiredOwner: 'worker-1' })

    expect(existsSync(retired)).toBe(false)
    for (const live of [replacement, unowned, otherProcess, otherTarget]) {
      expect(existsSync(live)).toBe(true)
    }
    expect(readFileSync(final, 'utf-8')).toBe('committed')
  })

  it('keeps current-process temps during the default stale sweep', async () => {
    const final = join(dir, 'state.json')
    const unowned = durableWriteTempPath(final)
    const owned = durableWriteTempPath(final, 'worker-1')
    const otherUnowned = `${final}.${process.pid + 1}.1.test.tmp`
    const otherOwned = `${final}.${process.pid + 1}.1.test.owner-worker-1.tmp`
    for (const temp of [unowned, owned, otherUnowned, otherOwned]) {
      writeFileSync(temp, 'pending')
    }

    await removeStaleDurableWriteTempFiles(final)

    expect(existsSync(unowned)).toBe(true)
    expect(existsSync(owned)).toBe(true)
    expect(existsSync(otherUnowned)).toBe(false)
    expect(existsSync(otherOwned)).toBe(false)
  })
})
