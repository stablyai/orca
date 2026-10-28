import {
  chmodSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalFileSink, getRotatedFamilySize, listRotatedFiles } from './local-file-sink'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-sink-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeRecord(i: number): { i: number; payload: string } {
  return { i, payload: 'x'.repeat(100) }
}

describe('local-file-sink — basic write', () => {
  it('writes one NDJSON line per push', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100
    })
    sink.push({ a: 1 })
    sink.push({ b: 2 })
    await sink.flushAsync()
    sink.close()

    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ a: 1 })
    expect(JSON.parse(lines[1])).toEqual({ b: 2 })
  })

  it('creates trace directories and files with private POSIX permissions', () => {
    if (process.platform === 'win32') {
      return
    }
    const file = join(dir, 'logs', 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100_000
    })
    sink.push({ ok: true })
    sink.close()

    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('tightens permissions on an existing rotated trace family', () => {
    if (process.platform === 'win32') {
      return
    }
    const file = join(dir, 'test.ndjson')
    const rotated = `${file}.1`
    writeFileSync(file, '{}\n')
    writeFileSync(rotated, '{}\n')
    chmodSync(file, 0o644)
    chmodSync(rotated, 0o644)

    const sink = createLocalFileSink({
      filePath: file,
      maxFiles: 3,
      batchWindowMs: 100_000
    })
    sink.close()

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(rotated).mode & 0o777).toBe(0o600)
  })
})

describe('local-file-sink — rotation', () => {
  it('rotates when the byte cap is exceeded', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 3,
      batchWindowMs: 100_000
    })
    for (let i = 0; i < 8; i++) {
      sink.push(makeRecord(i))
      await sink.flushAsync()
    }
    sink.close()

    const files = listRotatedFiles(file, 3)
    expect(files.length).toBeGreaterThan(1)
    expect(existsSync(file)).toBe(true)
  })

  it('uses UTF-8 byte length for rotation accounting', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 90,
      maxFiles: 3,
      batchWindowMs: 100_000
    })
    sink.push({ payload: '😀'.repeat(15) })
    await sink.flushAsync()
    sink.push({ payload: '😀'.repeat(15) })
    await sink.flushAsync()
    sink.close()

    expect(listRotatedFiles(file, 3).length).toBeGreaterThan(1)
  })

  it('drops an individual record that exceeds the file byte cap', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 100,
      maxFiles: 3,
      batchWindowMs: 100_000
    })
    sink.push({ payload: 'x'.repeat(1_000) })
    sink.push({ ok: true })
    await sink.flushAsync()
    sink.close()

    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ ok: true }])
    expect(getRotatedFamilySize(file, 3)).toBeLessThanOrEqual(100)
  })

  it('keeps every record of a batch larger than the byte cap', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 170,
      maxFiles: 5,
      batchWindowMs: 100_000
    })
    sink.push({ i: 1, payload: 'x'.repeat(60) })
    sink.push({ i: 2, payload: 'x'.repeat(60) })
    sink.push({ i: 3, payload: 'x'.repeat(60) })
    await sink.flushAsync()
    sink.close()

    const allRecords = listRotatedFiles(file, 5)
      .flatMap((path) => readFileSync(path, 'utf8').split('\n').filter(Boolean))
      .map((line) => JSON.parse(line) as { i: number })
      .map((record) => record.i)
      .sort((a, b) => a - b)
    expect(allRecords).toEqual([1, 2, 3])
  })

  it('flushes synchronously at crash boundaries', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({ filePath: file, batchWindowMs: 100_000 })
    sink.push({ i: 1 })
    sink.push({ i: 2 })
    sink.flush()

    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ i: 1 }, { i: 2 }])
    sink.close()
  })

  it('resolves concurrent flushAsync calls only after the shared batch is written', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({ filePath: file, batchWindowMs: 100_000 })
    sink.push({ i: 1 })
    const first = sink.flushAsync()
    await sink.flushAsync()
    expect(readFileSync(file, 'utf8')).toBe('{"i":1}\n')
    await first
    sink.close()
  })

  it('keeps 100 crash-boundary write/flush pairs within the rotation bound', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 3,
      batchWindowMs: 1
    })
    const activeSize = (): number => (existsSync(file) ? statSync(file).size : 0)
    for (let i = 0; i < 100; i++) {
      sink.push(makeRecord(i))
      sink.flush()
      // The drain the push scheduled sizes the synchronous append and rotates it.
      await vi.waitFor(() => expect(activeSize()).toBeLessThanOrEqual(500), { timeout: 10_000 })
    }
    expect(existsSync(`${file}.2`)).toBe(true)
    // Each generation can hold one record past the cap before the drain moves it aside.
    expect(getRotatedFamilySize(file, 3)).toBeLessThan(3 * 500 * 2)
    sink.close()
  })

  it('caps total disk usage at maxFiles × maxBytes (worst case)', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 3,
      batchWindowMs: 100_000
    })
    for (let i = 0; i < 50; i++) {
      sink.push(makeRecord(i))
      await sink.flushAsync()
    }
    sink.close()

    const total = getRotatedFamilySize(file, 3)
    // Allow rotation headroom while still rejecting unbounded disk growth.
    expect(total).toBeLessThan(3 * 500 * 2)
  })
})

describe('local-file-sink — listing + clearing', () => {
  it('lists newest → oldest', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 200,
      maxFiles: 5,
      batchWindowMs: 100_000
    })
    for (let i = 0; i < 20; i++) {
      sink.push(makeRecord(i))
      await sink.flushAsync()
    }
    sink.close()

    const files = listRotatedFiles(file, 5)
    expect(files[0]).toBe(file)
    for (let i = 1; i < files.length; i++) {
      expect(files[i]).toBe(`${file}.${i}`)
    }
  })
})

describe('local-file-sink — robustness', () => {
  it('does not throw on circular records (drops the line)', async () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100_000
    })
    const a: Record<string, unknown> = { ok: true }
    a.self = a
    expect(() => {
      sink.push(a)
      sink.push({ ok: 2 })
    }).not.toThrow()
    await sink.flushAsync()
    sink.close()
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: 2 }])
  })

  it('survives close-after-close', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({ filePath: file })
    sink.close()
    expect(() => sink.close()).not.toThrow()
  })
})
