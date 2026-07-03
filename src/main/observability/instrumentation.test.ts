import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTracerForTests, setActiveSink, type TracerSink } from './tracer'
import {
  _gitSpanSamplingBucketCountForTests,
  _resetGitSpanSamplingForTests,
  withGitSpan
} from './instrumentation'

type SpanRecord = {
  readonly name: string
  readonly durationMs: number
  readonly attributes: Record<string, unknown>
  readonly exit: { readonly _tag: string; readonly cause?: string }
}

type CapturedSink = TracerSink & {
  readonly records: SpanRecord[]
}

function isSpanRecord(record: unknown): record is SpanRecord {
  return (
    record !== null &&
    typeof record === 'object' &&
    'name' in record &&
    typeof record.name === 'string' &&
    'durationMs' in record &&
    typeof record.durationMs === 'number' &&
    'attributes' in record &&
    record.attributes !== null &&
    typeof record.attributes === 'object' &&
    'exit' in record &&
    record.exit !== null &&
    typeof record.exit === 'object' &&
    '_tag' in record.exit &&
    typeof record.exit._tag === 'string'
  )
}

function makeCapturingSink(): CapturedSink {
  const records: SpanRecord[] = []
  return {
    records,
    push(record) {
      if (!isSpanRecord(record)) {
        throw new Error('expected span record')
      }
      records.push(record)
    },
    flush() {
      /* no-op */
    },
    close() {
      /* no-op */
    }
  }
}

let sink: CapturedSink
let nowMs = 1_700_000_000_000

async function runGitSpan(
  meta: { args: readonly string[]; cwd?: string },
  durationMs: number,
  fail = false
) {
  vi.setSystemTime(nowMs)
  const promise = withGitSpan(meta, async () => {
    vi.setSystemTime(nowMs + durationMs)
    if (fail) {
      throw new Error('git failed')
    }
    return 'ok'
  })
  nowMs += durationMs + 1
  return await promise
}

beforeEach(() => {
  vi.useFakeTimers()
  nowMs = 1_700_000_000_000
  _resetGitSpanSamplingForTests()
  sink = makeCapturingSink()
  setActiveSink(sink)
})

afterEach(() => {
  vi.useRealTimers()
  _resetGitSpanSamplingForTests()
  _resetTracerForTests()
})

describe('withGitSpan sampling', () => {
  it('bounds fast successful repeated git spans by subcommand and cwd while preserving important spans', async () => {
    for (let i = 0; i < 10_000; i++) {
      await runGitSpan({ args: ['status', '--short'], cwd: '/repo' }, 5)
    }

    const repeatedFastSuccesses = sink.records.filter(
      (record) =>
        record.name === 'git.exec' &&
        record.exit._tag === 'Success' &&
        record.attributes['git.subcommand'] === 'status' &&
        record.attributes.cwd === '/repo' &&
        record.durationMs < 250
    )
    expect(repeatedFastSuccesses.length).toBeGreaterThan(0)
    expect(repeatedFastSuccesses.length).toBeLessThan(200)

    await expect(runGitSpan({ args: ['status'], cwd: '/repo' }, 5, true)).rejects.toThrow(
      'git failed'
    )
    await runGitSpan({ args: ['status'], cwd: '/repo' }, 275)
    await runGitSpan({ args: ['branch'], cwd: '/repo' }, 5)
    await runGitSpan({ args: ['status'], cwd: '/other-repo' }, 5)

    expect(
      sink.records.some(
        (record) =>
          record.exit._tag === 'Failure' &&
          record.attributes['git.subcommand'] === 'status' &&
          record.attributes.cwd === '/repo'
      )
    ).toBe(true)
    expect(
      sink.records.some(
        (record) =>
          record.exit._tag === 'Success' &&
          record.durationMs >= 250 &&
          record.attributes['git.subcommand'] === 'status' &&
          record.attributes.cwd === '/repo'
      )
    ).toBe(true)
    expect(
      sink.records.some(
        (record) =>
          record.exit._tag === 'Success' &&
          record.attributes['git.subcommand'] === 'branch' &&
          record.attributes.cwd === '/repo'
      )
    ).toBe(true)
    expect(
      sink.records.some(
        (record) =>
          record.exit._tag === 'Success' &&
          record.attributes['git.subcommand'] === 'status' &&
          record.attributes.cwd === '/other-repo'
      )
    ).toBe(true)
  })
  it('parses git subcommands after global options without changing arg count', async () => {
    await runGitSpan({ args: ['-c', 'core.quotePath=false', 'status', '--short'], cwd: '/repo' }, 5)

    expect(sink.records[0]?.attributes['git.subcommand']).toBe('status')
    expect(sink.records[0]?.attributes['git.arg_count']).toBe(4)
  })

  it('prunes stale git sampling buckets and caps unique cwd buckets', async () => {
    for (let i = 0; i < 700; i++) {
      await runGitSpan({ args: ['status'], cwd: `/repo-${i}` }, 5)
    }

    expect(_gitSpanSamplingBucketCountForTests()).toBeLessThanOrEqual(512)

    nowMs += 60_000
    await runGitSpan({ args: ['status'], cwd: '/fresh-repo' }, 5)

    expect(_gitSpanSamplingBucketCountForTests()).toBe(1)
  })
})
