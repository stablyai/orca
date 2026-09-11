// Regression: the daemon lifecycle log used to be appended after the trace family under one
// shared budget, so a trace family that filled the 4 MiB cap starved it to zero lines.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _internalsForTests, collectBundle } from './bundle'

let dir: string
let traceFile: string
let daemonFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-bundle-daemon-'))
  traceFile = join(dir, 'main.trace.ndjson')
  daemonFile = join(dir, 'daemon.log')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeSpan(name: string, padBytes: number): Record<string, unknown> {
  const now = BigInt(Date.now()) * 1_000_000n
  return {
    type: 'effect-span',
    name,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    kind: 'internal',
    startTimeUnixNano: String(now - 1_000_000_000n),
    endTimeUnixNano: String(now),
    durationMs: 1,
    attributes: { message: 'x'.repeat(padBytes) },
    events: [],
    exit: { _tag: 'Success' }
  }
}

/** Lines are read from EOF backwards, so the newest-first list is written reversed. */
function writeNewestFirst(file: string, newestFirst: string[]): void {
  writeFileSync(file, `${newestFirst.toReversed().join('\n')}\n`)
}

function daemonRecord(event: string, totalBytes: number): string {
  const base = JSON.stringify({
    src: 'daemon',
    ts: new Date().toISOString(),
    pid: 1,
    event,
    detail: ''
  })
  return JSON.stringify({
    src: 'daemon',
    ts: new Date().toISOString(),
    pid: 1,
    event,
    detail: 'z'.repeat(Math.max(0, totalBytes - base.length))
  })
}

/** A span whose serialized length is exactly `totalBytes`. */
function exactSpan(name: string, totalBytes: number): string {
  const empty = JSON.stringify(makeSpan(name, 0))
  return JSON.stringify(makeSpan(name, Math.max(0, totalBytes - empty.length)))
}

function collectWith(traceFile: string, daemonFile: string): ReturnType<typeof collectBundle> {
  return collectBundle({
    traceFilePath: traceFile,
    maxFiles: 10,
    daemonLogFilePath: daemonFile,
    daemonLogMaxFiles: 3,
    lookbackMinutes: 30,
    appVersion: '1',
    platform: 'darwin',
    arch: 'arm64',
    osRelease: '24',
    orcaChannel: 'dev'
  })
}

describe('bundle — daemon log under byte-cap pressure', () => {
  it('still merges a recent daemon lifecycle line when the trace family fills the cap', () => {
    // Six 1 MiB spans (~6 MiB) guarantee the cap is exhausted inside the trace file.
    const oneMiB = 1024 * 1024
    const spans = Array.from({ length: 6 }, (_, i) => makeSpan(`trace-span-${String(i)}`, oneMiB))
    writeFileSync(traceFile, `${spans.map((s) => JSON.stringify(s)).join('\n')}\n`)
    writeFileSync(
      daemonFile,
      `${JSON.stringify({
        src: 'daemon',
        ts: new Date().toISOString(),
        pid: 1,
        event: 'session-exited',
        reason: 'the evidence a crash triage actually needs'
      })}\n`
    )

    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })

    const lines = bundle.payload.split('\n').filter((l) => l.length > 0)
    const traceNames = lines.flatMap((l) => /"name":"(trace-span-\d+)"/.exec(l)?.[1] ?? [])
    const daemonEvents = lines.flatMap((l) => /"event":"([^"]+)"/.exec(l)?.[1] ?? [])

    // Precondition: the cap really was exhausted by the trace family.
    expect(bundle.bytes).toBeGreaterThan(_internalsForTests.MAX_BUNDLE_BYTES - 2 * oneMiB)
    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    expect(traceNames).toContain('trace-span-5')

    // The daemon line is newer than every trace span it was starved by.
    expect(daemonEvents).toEqual(['session-exited'])
  })

  it('stays under the upload cap when both families overflow their budgets', () => {
    const oneMiB = 1024 * 1024
    const spans = Array.from({ length: 6 }, (_, i) => makeSpan(`trace-span-${String(i)}`, oneMiB))
    writeFileSync(traceFile, `${spans.map((s) => JSON.stringify(s)).join('\n')}\n`)
    // 40 x 32 KiB of daemon lines far exceeds the 256 KiB reserve.
    const daemonLines = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        src: 'daemon',
        ts: new Date().toISOString(),
        pid: 1,
        event: `daemon-event-${String(i)}`,
        detail: 'y'.repeat(32 * 1024)
      })
    )
    writeFileSync(daemonFile, `${daemonLines.join('\n')}\n`)

    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })

    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    // The daemon family is bounded by its reserve, and the newest daemon line survives.
    expect(bundle.payload).toContain('"event":"daemon-event-39"')
    expect(bundle.payload).not.toContain('"event":"daemon-event-0"')
    // The trace family still gets the overwhelming majority of the cap.
    expect(bundle.payload).toContain('"name":"trace-span-5"')
  })

  it('spends the whole cap on a heavy daemon log when the trace family is light', () => {
    // The reserve is a floor, not a ceiling: a quiet trace family must not leave the cap unspent
    // while a daemon in a restart loop is cut off at 256 KiB.
    writeFileSync(traceFile, `${JSON.stringify(makeSpan('trace-span-0', 1024))}\n`)
    const daemonLines = Array.from({ length: 32 }, (_, i) =>
      JSON.stringify({
        src: 'daemon',
        ts: new Date().toISOString(),
        pid: 1,
        event: `daemon-event-${String(i)}`,
        detail: 'y'.repeat(64 * 1024)
      })
    )
    writeFileSync(daemonFile, `${daemonLines.join('\n')}\n`)

    const bundle = collectBundle({
      traceFilePath: traceFile,
      maxFiles: 10,
      daemonLogFilePath: daemonFile,
      daemonLogMaxFiles: 3,
      lookbackMinutes: 30,
      appVersion: '1',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24',
      orcaChannel: 'dev'
    })

    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    // ~2 MiB of daemon lines must survive, not the 256 KiB the reserve alone would have allowed.
    expect(bundle.bytes).toBeGreaterThan(4 * _internalsForTests.DAEMON_LOG_RESERVE_BYTES)
    expect(bundle.payload).toContain('"event":"daemon-event-31"')
    expect(bundle.payload).toContain('"event":"daemon-event-0"')
  })

  it('never loses daemon lines the reserve pass had already collected', () => {
    // Collection is not monotonic in budget: a record the 256 KiB reserve pass skipped as
    // oversized can be admitted by the larger second-pass budget and then fill it, cutting off
    // every older line behind it. The larger pass must only be taken when it is actually better.
    const emptyTrace = join(dir, 'empty.trace.ndjson')
    writeFileSync(emptyTrace, '')
    writeFileSync(daemonFile, '')
    const available =
      _internalsForTests.MAX_BUNDLE_BYTES - collectWith(emptyTrace, daemonFile).bytes

    const secondPassBudget = 319_488
    writeNewestFirst(daemonFile, [
      daemonRecord('newest-lifecycle', 200),
      // Bigger than the 256 KiB reserve (so pass 1 skips it) but small enough for pass 2 to
      // admit it and then have no room left for the mediums behind it.
      daemonRecord('oversized-detail', secondPassBudget - 400),
      ...Array.from({ length: 6 }, (_, i) => daemonRecord(`m-${String(i)}`, 65_536))
    ])
    // One trace line sized so the second-pass daemon budget lands exactly on secondPassBudget.
    writeFileSync(traceFile, `${exactSpan('t-0', available - secondPassBudget - 1)}\n`)

    const bundle = collectWith(traceFile, daemonFile)
    const events = bundle.payload.split('\n').flatMap((l) => /"event":"([^"]+)"/.exec(l)?.[1] ?? [])

    expect(bundle.bytes).toBeLessThanOrEqual(_internalsForTests.MAX_BUNDLE_BYTES)
    // The reserve pass had already banked these; the second pass must not drop them.
    expect(events).toContain('newest-lifecycle')
    expect(events).toContain('m-0')
  })
})
