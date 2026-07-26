import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  renameDurable,
  renameDurableSync,
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

  describe('renameDurableSync', () => {
    it('publishes an already-written temp file at the final path', () => {
      const final = join(dir, 'state.json')
      const tmp = `${final}.tmp`
      writeFileSync(tmp, 'fresh', 'utf-8')
      renameDurableSync(tmp, final)
      expect(readFileSync(final, 'utf-8')).toBe('fresh')
      expect(() => readFileSync(tmp, 'utf-8')).toThrow()
    })

    it('replaces existing content and matches the async helper', async () => {
      const syncTarget = join(dir, 'sync.json')
      const asyncTarget = join(dir, 'async.json')
      writeFileSync(syncTarget, 'stale', 'utf-8')
      writeFileSync(asyncTarget, 'stale', 'utf-8')
      writeFileSync(`${syncTarget}.tmp`, 'fresh', 'utf-8')
      writeFileSync(`${asyncTarget}.tmp`, 'fresh', 'utf-8')

      renameDurableSync(`${syncTarget}.tmp`, syncTarget)
      await renameDurable(`${asyncTarget}.tmp`, asyncTarget)

      expect(readFileSync(syncTarget, 'utf-8')).toBe('fresh')
      expect(readFileSync(asyncTarget, 'utf-8')).toBe(readFileSync(syncTarget, 'utf-8'))
    })

    it('throws instead of silently failing when the temp file is missing', () => {
      const final = join(dir, 'state.json')
      expect(() => renameDurableSync(join(dir, 'nope.tmp'), final)).toThrow()
      expect(() => readFileSync(final, 'utf-8')).toThrow()
    })
  })
})
