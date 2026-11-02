import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalFileSink, DROPPED_RECORD_TYPE, type LocalFileSink } from './local-file-sink'

function parseLine(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>
}

let directory: string
let sink: LocalFileSink | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-trace-memory-'))
  vi.useFakeTimers()
})
afterEach(() => {
  sink?.close()
  sink = undefined
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

function retainedHeap(): number {
  if (!globalThis.gc) {
    throw new Error('Memory regression requires --expose-gc')
  }
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

describe('trace sink rejected record retention', () => {
  it('releases oversized serialized records before the pending batch flushes', async () => {
    const filePath = join(directory, 'trace.ndjson')
    sink = createLocalFileSink({ filePath, maxBytes: 64 * 1024, batchWindowMs: 200 })
    const before = retainedHeap()
    for (let index = 0; index < 24; index++) {
      sink.push({ index, payload: 'x'.repeat(1024 * 1024) })
    }
    const retained = retainedHeap() - before
    expect(existsSync(filePath)).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    expect(retained).toBeLessThan(5 * 1024 * 1024)
    sink.push({ valid: true })
    await sink.flushAsync()
    const written = readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(parseLine)
    expect(written.filter((entry) => entry.type === DROPPED_RECORD_TYPE)).toHaveLength(24)
    expect(written.at(-1)).toEqual({ valid: true })
  })

  it('accepts the exact UTF-8 byte cap and rotates at it', async () => {
    const filePath = join(directory, 'trace.ndjson')
    const record = { text: '💡' }
    const line = `${JSON.stringify(record)}\n`
    sink = createLocalFileSink({ filePath, maxBytes: Buffer.byteLength(line), maxFiles: 2 })
    sink.push(record)
    sink.push({ text: '💡x' })
    await sink.flushAsync()
    sink.push(record)
    await sink.flushAsync()
    expect(readFileSync(filePath, 'utf8')).toBe(line)
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe(line)
    expect(vi.getTimerCount()).toBe(0)
  })
})
