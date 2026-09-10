import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalFileSink,
  DROPPED_RECORD_TYPE,
  type LocalFileSink
} from './local-file-sink'

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
  it('keeps small-record byte scans deferred until the batch flush', () => {
    const filePath = join(directory, 'trace.ndjson')
    sink = createLocalFileSink({ filePath })
    const byteLength = vi.spyOn(Buffer, 'byteLength')
    let beforeFlush: number
    let afterFlush: number
    try {
      for (let index = 0; index < 20; index++) {
        sink.push({ index, text: '💡漢字' })
      }
      beforeFlush = byteLength.mock.calls.length
      sink.flush()
      afterFlush = byteLength.mock.calls.length
    } finally {
      byteLength.mockRestore()
    }
    expect(beforeFlush).toBe(0)
    expect(afterFlush).toBe(20)
  })

  it('releases oversized serialized records before the pending batch flushes', () => {
    const filePath = join(directory, 'trace.ndjson')
    sink = createLocalFileSink({ filePath, maxBytes: 64 * 1024, batchWindowMs: 200 })
    const before = retainedHeap()
    for (let index = 0; index < 24; index++) {
      sink.push({ index, payload: 'x'.repeat(1024 * 1024) })
    }
    const retained = retainedHeap() - before
    expect(statSync(filePath).size).toBe(0)
    expect(vi.getTimerCount()).toBe(1)
    expect(retained).toBeLessThan(5 * 1024 * 1024)
    sink.push({ valid: true })
    vi.advanceTimersByTime(200)
    const written = readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(parseLine)
    // Each rejected record leaves a marker, so the gap is readable instead of silent.
    expect(written.filter((entry) => entry.type === DROPPED_RECORD_TYPE)).toHaveLength(24)
    expect(written.at(-1)).toEqual({ valid: true })
  })

  it('names the dropped record in the marker instead of leaving a silent gap', () => {
    const filePath = join(directory, 'trace.ndjson')
    sink = createLocalFileSink({ filePath, maxBytes: 64 * 1024, flushBufferThreshold: 1 })
    sink.push({
      type: 'effect-span',
      name: 'worktree.create',
      traceId: 'a'.repeat(32),
      payload: 'x'.repeat(1024 * 1024)
    })
    const [marker] = readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(parseLine)
    expect(marker).toMatchObject({
      type: DROPPED_RECORD_TYPE,
      reason: 'oversize',
      name: 'worktree.create',
      traceId: 'a'.repeat(32)
    })
    expect(marker.droppedChars).toBeGreaterThan(1024 * 1024)
    // Timestamped so the bundle collector's lookback filter ages markers out like any other span.
    expect(BigInt(marker.endTimeUnixNano as string)).toBeGreaterThan(0n)
  })

  it('omits the marker when even the marker would exceed the byte cap', () => {
    const filePath = join(directory, 'trace.ndjson')
    sink = createLocalFileSink({ filePath, maxBytes: 40, flushBufferThreshold: 1 })
    sink.push({ payload: 'x'.repeat(1_000) })
    sink.push({ ok: 1 })
    expect(readFileSync(filePath, 'utf8')).toBe('{"ok":1}\n')
  })

  it('keeps the same count-triggered flush for valid records beside rejected ones', () => {
    const filePath = join(directory, 'trace.ndjson')
    sink = createLocalFileSink({ filePath, maxBytes: 32, flushBufferThreshold: 3 })
    sink.push({ valid: 1 })
    sink.push({ payload: '💡'.repeat(20) })
    expect(statSync(filePath).size).toBe(0)
    sink.push({ payload: 'x'.repeat(100) })
    expect(readFileSync(filePath, 'utf8')).toBe('{"valid":1}\n')
    sink.push({ valid: 2 })
    vi.advanceTimersByTime(200)
    expect(readFileSync(filePath, 'utf8')).toBe('{"valid":1}\n{"valid":2}\n')
  })

  it('accepts the exact UTF-8 byte cap and preserves rotation and close flushes', () => {
    const filePath = join(directory, 'trace.ndjson')
    const record = { text: '💡' }
    const line = `${JSON.stringify(record)}\n`
    sink = createLocalFileSink({ filePath, maxBytes: Buffer.byteLength(line), maxFiles: 2 })
    sink.push(record)
    sink.push({ text: '💡x' })
    sink.push(record)
    sink.close()
    expect(readFileSync(filePath, 'utf8')).toBe(line)
    expect(readFileSync(`${filePath}.1`, 'utf8')).toBe(line)
    expect(vi.getTimerCount()).toBe(0)
  })
})
