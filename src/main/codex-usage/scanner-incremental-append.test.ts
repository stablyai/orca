import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'

const { getPathMock, homedirMock, streamReads, onStreamOpen } = vi.hoisted(() => {
  const streamReads: { path: string; bytes: number; start: number; bounded: boolean }[] = []
  // Seam for mutating the tree mid-scan, between two files' parse reads.
  const onStreamOpen: { current: ((path: string, bounded: boolean) => void) | null } = {
    current: null
  }
  return {
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    streamReads,
    onStreamOpen
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

// The perf oracle: every byte the scanner streams out of a session file.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    createReadStream: (
      path: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1]
    ) => {
      const filePath = String(path)
      const range = typeof options === 'object' && options !== null ? options : {}
      const start = range.start ?? 0
      const size = actual.statSync(filePath).size
      const stop = range.end === undefined ? size : Math.min(size, range.end + 1)
      streamReads.push({
        path: filePath,
        bytes: Math.max(0, stop - start),
        start,
        bounded: range.end !== undefined
      })
      onStreamOpen.current?.(filePath, range.end !== undefined)
      return actual.createReadStream(path, options)
    }
  }
})

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsagePersistedFile } from './types'

/** Mirrors BOUNDARY_WINDOW_BYTES in codex-rollout-resume-state.ts. */
const BOUNDARY_WINDOW_BYTES = 4096

/** Enough records (~377 B each) to put a prefix past MIN_RESUMABLE_PREFIX_BYTES.
 *  A shorter rollout is always reparsed whole, so a test meaning to exercise the
 *  resume path has to clear the floor or it silently stops testing anything. */
const RESUMABLE_RECORDS = 40

const originalCodexHome = process.env.CODEX_HOME
let fakeHomeDir: string
let userDataDir: string
let sessionsDir: string
let previousUserDataPath: string | undefined

function usageRecord(timestamp: string, inputTokens: number, totalInputTokens: number): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens
        },
        total_token_usage: {
          input_tokens: totalInputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalInputTokens
        }
      }
    }
  })}\n`
}

function totalOnlyUsageRecord(timestamp: string, totalInputTokens: number): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        total_token_usage: {
          input_tokens: totalInputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalInputTokens
        }
      }
    }
  })}\n`
}

function sessionMeta(id: string): string {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd: join(fakeHomeDir, 'repo') }
  })}\n`
}

/** Records numbered [from, to), each worth one token, cumulative totals. */
function usageRecordRange(from: number, to: number): string {
  let out = ''
  for (let index = from; index < to; index++) {
    const minute = String(index % 60).padStart(2, '0')
    // Midday UTC keeps the derived local day stable across test-runner zones.
    const hour = String(12 + (Math.floor(index / 60) % 4)).padStart(2, '0')
    out += usageRecord(`2026-05-26T${hour}:${minute}:00.000Z`, 1, index + 1)
  }
  return out
}

function bytesReadFor(filePath: string): number {
  return streamReads
    .filter((entry) => entry.path === filePath)
    .reduce((total, entry) => total + entry.bytes, 0)
}

/** Offsets at which this file's parse reads opened, in order. Bounded reads are
 *  digest windows; an unbounded one at 0 is a full reparse and at the recorded
 *  offset is a resume, so this says exactly which path a scan took. */
function parseReadOffsets(filePath: string): number[] {
  return streamReads
    .filter((entry) => entry.path === filePath && !entry.bounded)
    .map((entry) => entry.start)
}

function reparsedFromStart(filePath: string): boolean {
  return parseReadOffsets(filePath).includes(0)
}

function recordedResumeOffset(
  files: { path: string; parseResumeState?: { parsedBytes: number } | null }[],
  filePath: string
): number {
  return files.find((file) => file.path === filePath)?.parseResumeState?.parsedBytes ?? 0
}

/** Which session each record was attributed to. Totals can be identical across
 *  a misattribution, so this is the oracle for anything context-related. */
function eventCountsBySession(sessions: { sessionId: string; eventCount: number }[]): unknown[] {
  return sessions.map((session) => [session.sessionId, session.eventCount]).sort()
}

function totalTokens(aggregates: { totalTokens: number }[]): number {
  return aggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
}

beforeEach(() => {
  delete process.env.CODEX_HOME
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-incremental-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-incremental-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  streamReads.length = 0
  onStreamOpen.current = null
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('scanCodexUsageFiles incremental append', () => {
  it('re-reads only the appended bytes when a rollout grows', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-grow.jsonl')
    writeFileSync(rolloutPath, `${sessionMeta('session-grow')}${usageRecordRange(0, 200)}`, 'utf-8')
    const sizeBeforeAppend = statSync(rolloutPath).size

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(200)
    expect(bytesReadFor(rolloutPath)).toBeGreaterThanOrEqual(sizeBeforeAppend)

    streamReads.length = 0
    appendFileSync(rolloutPath, usageRecordRange(200, 202), 'utf-8')
    const appendedBytes = statSync(rolloutPath).size - sizeBeforeAppend

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(202)
    expect(second.sessions[0]?.eventCount).toBe(202)

    // The defect: the scanner restarts at byte 0 and re-reads the whole file.
    // The fix reads the appended bytes plus five bounded windows: a head and a
    // boundary window to plan the resume, both again at the point of use so a
    // rollout replaced in between cannot be stitched onto, then the moved
    // boundary to record the new resume point.
    expect(reparsedFromStart(rolloutPath)).toBe(false)
    expect(bytesReadFor(rolloutPath)).toBeLessThan(sizeBeforeAppend)
    expect(bytesReadFor(rolloutPath)).toBeLessThanOrEqual(appendedBytes + 5 * BOUNDARY_WINDOW_BYTES)
  })

  it('carries cumulative token totals across the resume boundary', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-cumulative.jsonl')
    writeFileSync(
      rolloutPath,
      [
        sessionMeta('session-cumulative'),
        // Padding to clear the resumable floor; each record is worth one token
        // and leaves the running total at RESUMABLE_RECORDS.
        usageRecordRange(0, RESUMABLE_RECORDS),
        totalOnlyUsageRecord('2026-05-26T13:00:00.000Z', RESUMABLE_RECORDS + 100),
        totalOnlyUsageRecord('2026-05-26T13:01:00.000Z', RESUMABLE_RECORDS + 250)
      ].join(''),
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS + 250)
    const resumeOffset = recordedResumeOffset(first.processedFiles, rolloutPath)

    // Only the running total is on the wire, so the appended record's delta
    // depends entirely on the totals carried out of the previous scan.
    appendFileSync(
      rolloutPath,
      totalOnlyUsageRecord('2026-05-26T13:02:00.000Z', RESUMABLE_RECORDS + 400),
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReadOffsets(rolloutPath)).toEqual([resumeOffset])
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 400)
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
  })

  it('still reuses an untouched rollout without reading it', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-idle.jsonl')
    writeFileSync(rolloutPath, `${sessionMeta('session-idle')}${usageRecordRange(0, 50)}`, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    streamReads.length = 0

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(bytesReadFor(rolloutPath)).toBe(0)
    expect(totalTokens(second.dailyAggregates)).toBe(50)
  })

  it('tracks byte offsets through CRLF line endings', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-crlf.jsonl')
    const toCrlf = (text: string): string => text.replaceAll('\n', '\r\n')
    writeFileSync(
      rolloutPath,
      toCrlf(`${sessionMeta('session-crlf')}${usageRecordRange(0, RESUMABLE_RECORDS)}`),
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    const resumeOffset = recordedResumeOffset(first.processedFiles, rolloutPath)

    appendFileSync(
      rolloutPath,
      toCrlf(usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 3)),
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    // A one-byte-per-line drift would put this offset inside a record.
    expect(parseReadOffsets(rolloutPath)).toEqual([resumeOffset])
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 3)
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  it('matches a full rescan after repeated appends', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-chatty.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-chatty')}${usageRecordRange(0, RESUMABLE_RECORDS)}`,
      'utf-8'
    )

    let processedFiles: CodexUsagePersistedFile[] = []
    let scanned = await scanCodexUsageFiles([], processedFiles)
    processedFiles = scanned.processedFiles

    for (let round = 1; round <= 5; round++) {
      const from = RESUMABLE_RECORDS + (round - 1) * 10
      appendFileSync(rolloutPath, usageRecordRange(from, from + 10), 'utf-8')
      streamReads.length = 0
      scanned = await scanCodexUsageFiles([], processedFiles)
      // Every round after the first has to resume, not restart.
      expect(reparsedFromStart(rolloutPath)).toBe(false)
      processedFiles = scanned.processedFiles
    }

    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(scanned.dailyAggregates)).toBe(RESUMABLE_RECORDS + 50)
    expect(scanned.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(scanned.sessions).toEqual(fromScratch.sessions)
  })

  it('falls back to a full reparse when a rollout is truncated', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-truncated.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-truncated')}${usageRecordRange(0, RESUMABLE_RECORDS)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    // Without a recorded resume point the fallback below would be trivial.
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    writeFileSync(rolloutPath, `${sessionMeta('session-truncated')}${usageRecordRange(0, 5)}`)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(5)
  })

  // The point-of-use re-check runs just before the parse read opens, so a
  // rollout truncated in the gap still resumes into a file that no longer
  // reaches the offset: the stream yields nothing and the whole pre-truncation
  // history survives the merge as this scan's answer.
  it('reparses from the start when a rollout shrinks during its parse read', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-shrinks-mid-read.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-shrinker')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    const resumeOffset = recordedResumeOffset(first.processedFiles, rolloutPath)

    appendFileSync(rolloutPath, usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 2), 'utf-8')
    const truncated = `${sessionMeta('session-shrinker')}${usageRecordRange(0, 5)}`
    onStreamOpen.current = (path, bounded) => {
      // Bounded reads are the digest windows; the unbounded one is the parse
      // read, which opens after every check this scan is going to make.
      if (path === rolloutPath && !bounded) {
        onStreamOpen.current = null
        writeFileSync(path, truncated, 'utf-8')
      }
    }

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(onStreamOpen.current).toBeNull()
    // Resumed at the recorded offset, then restarted: both halves are the point.
    expect(parseReadOffsets(rolloutPath)).toEqual([resumeOffset, 0])
    expect(totalTokens(second.dailyAggregates)).toBe(5)
    expect(second.sessions[0]?.eventCount).toBe(5)
    // Nothing resumable may survive either: the recorded prefix is gone.
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(totalTokens(third.dailyAggregates)).toBe(5)
  })

  // The other direction, and the worse half: a replacement *longer* than the
  // recorded offset reads full windows, so no short read can fire. The cached
  // context — session id, cwd, model, running totals — is stitched onto an
  // unrelated file's records, running cumulative-delta arithmetic across two
  // files that have nothing to do with each other.
  //
  // Token totals and daily aggregates come out byte-identical to a cold scan
  // here: the stale prefix contributes exactly as many events as the resumed
  // read skips. Attribution is the only surviving signal, so the oracle is the
  // session shape — a totals-based one is provably blind to this.
  it('reparses from the start when a rollout is replaced by a larger file mid-scan', async () => {
    const driverPath = join(sessionsDir, 'aaaa-driver.jsonl')
    const targetPath = join(sessionsDir, 'zzzz-grower.jsonl')
    writeFileSync(driverPath, `${sessionMeta('session-driver')}${usageRecordRange(120, 123)}`)
    writeFileSync(
      targetPath,
      `${sessionMeta('session-grower')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    )

    const first = await scanCodexUsageFiles([], [])
    const resumeOffset =
      first.processedFiles.find((file) => file.path === targetPath)?.parseResumeState
        ?.parsedBytes ?? 0

    appendFileSync(driverPath, usageRecordRange(123, 124), 'utf-8')
    appendFileSync(targetPath, usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 2), 'utf-8')
    const replacement = `${sessionMeta('session-other')}${usageRecordRange(200, 260)}`
    // Past the recorded offset, so every digest window still reads its full size.
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(resumeOffset)
    onStreamOpen.current = (path, bounded) => {
      // Lands while the earlier-sorted rollout is being parsed, which is after
      // the scanner's discovery loop verified every file's prefix.
      if (path === driverPath && !bounded) {
        onStreamOpen.current = null
        writeFileSync(targetPath, replacement, 'utf-8')
      }
    }

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(onStreamOpen.current).toBeNull()
    // The scan planned to resume here, and the point-of-use check is what sends
    // it back to byte 0 before a single suffix byte is read.
    expect(resumeOffset).toBeGreaterThan(0)
    expect(parseReadOffsets(targetPath)).toEqual([0])
    const fromScratch = await scanCodexUsageFiles([], [])

    // Stitching leaves `session-grower` owning the records of `session-other`.
    expect(eventCountsBySession(second.sessions)).toEqual(
      eventCountsBySession(fromScratch.sessions)
    )
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  it('falls back to a full reparse when a rollout is rewritten at the same size', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-replaced.jsonl')
    const original = `${sessionMeta('session-a')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    // Byte-identical length, different content: only the year changes.
    const replacement = original.replaceAll('2026-05-26T', '2027-05-26T')
    expect(replacement.length).toBe(original.length)
    writeFileSync(rolloutPath, replacement, 'utf-8')
    expect(statSync(rolloutPath).size).toBe(original.length)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  it('falls back to a full reparse when a rewritten rollout also grows', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-rotated.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-a')}${usageRecordRange(0, RESUMABLE_RECORDS)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    // Rotation: a fresh, longer file lands at the same path.
    rmSync(rolloutPath)
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-b')}${usageRecordRange(0, RESUMABLE_RECORDS + 5).replaceAll('2026-', '2027-')}`,
      'utf-8'
    )

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 5)
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  /** A rollout whose leading records differ but whose trailing records — more
   *  than a boundary window of them — are byte-identical, at the same length.
   *  The boundary digest is blind to this by construction. */
  function prefixSwapPair(sessionId: string): { original: string; replacement: string } {
    const sharedSuffix = usageRecordRange(20, 40)
    expect(sharedSuffix.length).toBeGreaterThan(BOUNDARY_WINDOW_BYTES)
    let swappedPrefix = ''
    for (let index = 0; index < 20; index++) {
      const minute = String(index % 60).padStart(2, '0')
      swappedPrefix += usageRecord(`2026-05-26T12:${minute}:00.000Z`, 3, index + 1)
    }
    const original = `${sessionMeta(sessionId)}${usageRecordRange(0, 20)}${sharedSuffix}`
    const replacement = `${sessionMeta(sessionId)}${swappedPrefix}${sharedSuffix}`
    expect(replacement.length).toBe(original.length)
    return { original, replacement }
  }

  // The mirror image of the prefix swap: the head window is byte-identical, so
  // only the boundary window is left to notice that trailing records changed.
  it('falls back to a full reparse when the records before the offset changed', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-tail-swap.jsonl')
    const swappedFrom = RESUMABLE_RECORDS
    const swappedTo = RESUMABLE_RECORDS + 10
    const sharedHead = `${sessionMeta('session-tail')}${usageRecordRange(0, swappedFrom)}`
    expect(sharedHead.length).toBeGreaterThan(BOUNDARY_WINDOW_BYTES)
    let heavierTail = ''
    for (let index = swappedFrom; index < swappedTo; index++) {
      const minute = String(index % 60).padStart(2, '0')
      const hour = String(12 + (Math.floor(index / 60) % 4)).padStart(2, '0')
      heavierTail += usageRecord(`2026-05-26T${hour}:${minute}:00.000Z`, 3, index + 1)
    }
    const original = `${sharedHead}${usageRecordRange(swappedFrom, swappedTo)}`
    const replacement = `${sharedHead}${heavierTail}`
    expect(replacement.length).toBe(original.length)
    // Only the bytes inside the boundary window differ, so the head digest is
    // blind to this and the boundary digest is the one guard under test.
    expect(original.length - sharedHead.length).toBeLessThan(BOUNDARY_WINDOW_BYTES)
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(swappedTo)
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    writeFileSync(rolloutPath, replacement, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(swappedFrom + 10 * 3)
  })

  // Rotation: the path is unlinked and recreated. `physicalFileId` cannot carry
  // this — ext4 and overlayfs hand the new file the inode the old one freed —
  // so the head window is what has to catch it on Linux.
  it('falls back to a full reparse when a recreated rollout swapped its prefix', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-prefix-swap-rotated.jsonl')
    const { original, replacement } = prefixSwapPair('session-prefix-rotated')
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    rmSync(rolloutPath)
    writeFileSync(rolloutPath, replacement, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(80)
  })

  // The same swap written in place. No inode changes on any platform, so the
  // head window is the only guard left — this is the case that was missed on
  // macOS too, not just on Linux.
  it('falls back to a full reparse when a prefix was rewritten in place', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-prefix-swap-in-place.jsonl')
    const { original, replacement } = prefixSwapPair('session-prefix-in-place')
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    const inodeBefore = statSync(rolloutPath).ino
    writeFileSync(rolloutPath, replacement, 'utf-8')
    // Pins why this test is not a duplicate of the rotation case above.
    expect(statSync(rolloutPath).ino).toBe(inodeBefore)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(80)
  })

  // A new session is too short to be worth resuming, so it records no resume
  // point and is reparsed whole. Once it grows past the floor it has to start
  // resuming, rather than staying on the full-reparse path for the rest of its
  // life because the first scan left nothing behind.
  it('starts resuming once the prefix grows past the resumable floor', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-crosses-floor.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-crosses')}${usageRecordRange(0, 3)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(3)
    expect(first.processedFiles[0]?.parseResumeState).toBeNull()

    streamReads.length = 0
    appendFileSync(rolloutPath, usageRecordRange(3, RESUMABLE_RECORDS), 'utf-8')
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    // Nothing to resume from yet, so this scan reads the whole file.
    expect(parseReadOffsets(rolloutPath)).toEqual([0])
    const resumeOffset = recordedResumeOffset(second.processedFiles, rolloutPath)
    expect(resumeOffset).toBeGreaterThan(0)

    streamReads.length = 0
    appendFileSync(rolloutPath, usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 2), 'utf-8')
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(totalTokens(third.dailyAggregates)).toBe(RESUMABLE_RECORDS + 2)
    expect(parseReadOffsets(rolloutPath)).toEqual([resumeOffset])
  })

  it('does not double-count a record completed after a partial trailing line', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-partial.jsonl')
    const complete = usageRecordRange(0, RESUMABLE_RECORDS)
    const pending = usageRecord('2026-05-26T12:59:00.000Z', 1, RESUMABLE_RECORDS + 1)
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-partial')}${complete}${pending.slice(0, 40)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)

    // The writer finishes the line and appends one more record.
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-partial')}${complete}${pending}${usageRecordRange(RESUMABLE_RECORDS + 1, RESUMABLE_RECORDS + 2)}`,
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    // The partial tail sits past the recorded offset, so this resumes onto it.
    expect(parseReadOffsets(rolloutPath)).toEqual([
      recordedResumeOffset(first.processedFiles, rolloutPath)
    ])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 2)
    expect(second.sessions[0]?.eventCount).toBe(RESUMABLE_RECORDS + 2)
  })

  // The case above stops at the parser: its tail is truncated JSON, so no event
  // comes out of it. A tail that is complete JSON with only the newline missing
  // is counted, yet the next scan re-reads it — the resume offset must exclude
  // it or the record lands in the totals twice.
  it('does not double-count a counted tail whose newline was not yet written', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-unflushed-newline.jsonl')
    const complete = usageRecordRange(0, RESUMABLE_RECORDS)
    const pending = usageRecord('2026-05-26T12:59:00.000Z', 1, RESUMABLE_RECORDS + 1)
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-unflushed')}${complete}${pending.slice(0, -1)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    // The unterminated line is valid JSON, so it is parsed and counted here.
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS + 1)
    expect(first.sessions[0]?.eventCount).toBe(RESUMABLE_RECORDS + 1)
    // The prefix clears the resumable floor, so suppressing the resume point is
    // the only thing that can force the reparse asserted below.
    expect(first.processedFiles[0]?.parseResumeState).toBeNull()

    // The writer flushes the newline and appends one more record.
    appendFileSync(
      rolloutPath,
      `\n${usageRecordRange(RESUMABLE_RECORDS + 1, RESUMABLE_RECORDS + 2)}`,
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReadOffsets(rolloutPath)).toEqual([0])
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 2)
    expect(second.sessions[0]?.eventCount).toBe(RESUMABLE_RECORDS + 2)
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
  })

  it('reads appended bytes only when the append shares the cached mtime', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-same-mtime.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-same-mtime')}${usageRecordRange(0, 40)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)
    streamReads.length = 0

    appendFileSync(rolloutPath, usageRecordRange(40, 42), 'utf-8')
    // A coarse-mtime filesystem reports the append under the cached mtime.
    const coarseMtimeMs = statSync(rolloutPath).mtimeMs
    const cached = first.processedFiles.map((file) =>
      file.path === rolloutPath ? { ...file, mtimeMs: coarseMtimeMs } : file
    )

    const second = await scanCodexUsageFiles([], cached)
    expect(totalTokens(second.dailyAggregates)).toBe(42)
    expect(second.sessions[0]?.eventCount).toBe(42)
    expect(reparsedFromStart(rolloutPath)).toBe(false)
  })

  it('keeps fork ownership when the owning rollout grows incrementally', async () => {
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-fork.jsonl')
    const copiedPrefix = `${sessionMeta('session-fork')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(
      forkPath,
      `${copiedPrefix}${usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 2)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS + 2)
    expect(first.processedFiles.find((file) => file.path === originalPath)?.ownedEventKeys).toEqual(
      expect.arrayContaining([expect.any(String)])
    )

    const resumeOffset = recordedResumeOffset(first.processedFiles, originalPath)
    appendFileSync(
      originalPath,
      usageRecordRange(RESUMABLE_RECORDS + 2, RESUMABLE_RECORDS + 4),
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReadOffsets(originalPath)).toEqual([resumeOffset])
    // shared + 2 fork-only + 2 newly appended, each counted exactly once.
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 4)
    const originalAfter = second.processedFiles.find((file) => file.path === originalPath)
    const forkAfter = second.processedFiles.find((file) => file.path === forkPath)
    expect(originalAfter?.ownedEventKeys).toHaveLength(RESUMABLE_RECORDS + 2)
    expect(forkAfter?.ownedEventKeys).toHaveLength(2)
    expect(forkAfter?.hasDeferredClaims).toBe(true)
  })

  it('keeps a new fork from re-claiming events a resumed rollout still owns', async () => {
    const originalPath = join(sessionsDir, 'aaaa-origin.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-late-fork.jsonl')
    const copiedPrefix = `${sessionMeta('session-late')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    writeFileSync(originalPath, copiedPrefix, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    const resumeOffset = recordedResumeOffset(first.processedFiles, originalPath)

    // The owner grows (resume path) in the same cycle a fork of its prefix appears.
    appendFileSync(
      originalPath,
      usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 2),
      'utf-8'
    )
    writeFileSync(
      forkPath,
      `${copiedPrefix}${usageRecordRange(RESUMABLE_RECORDS + 2, RESUMABLE_RECORDS + 3)}`,
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReadOffsets(originalPath)).toEqual([resumeOffset])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 3)
    const forkAfter = second.processedFiles.find((file) => file.path === forkPath)
    expect(forkAfter?.ownedEventKeys).toHaveLength(1)
    expect(forkAfter?.hasDeferredClaims).toBe(true)
  })

  // Pins why the scanner verifies resume points before it seeds event ownership
  // rather than leaving it to the parse. A rollout that fails verification must
  // not reserve the keys it used to own: a fork holding those same records is
  // the only file left that can count them.
  it('lets a fork reclaim records a rewritten rollout can no longer own', async () => {
    const originalPath = join(sessionsDir, 'aaaa-rewritten.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-inheritor.jsonl')
    const sharedPrefix = `${sessionMeta('session-shared')}${usageRecordRange(0, 40)}`
    writeFileSync(originalPath, sharedPrefix, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    // The owner is rewritten into an unrelated session, so its resume point no
    // longer verifies; a fork carrying its old records appears the same cycle.
    writeFileSync(
      originalPath,
      `${sessionMeta('session-rewritten')}${usageRecordRange(100, 140)}`,
      'utf-8'
    )
    writeFileSync(forkPath, `${sharedPrefix}${usageRecordRange(40, 43)}`, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(eventCountsBySession(second.sessions)).toEqual(
      eventCountsBySession(fromScratch.sessions)
    )
    expect(totalTokens(second.dailyAggregates)).toBe(83)
  })

  it('still reclaims deferred fork claims after an incremental append', async () => {
    const originalPath = join(sessionsDir, 'aaaa-owner.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-deferred.jsonl')
    const copiedPrefix = `${sessionMeta('session-deferred')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(
      forkPath,
      `${copiedPrefix}${usageRecordRange(RESUMABLE_RECORDS, RESUMABLE_RECORDS + 2)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    const resumeOffset = recordedResumeOffset(first.processedFiles, forkPath)
    // The deferring fork is the one that grows, so its deferred flag has to
    // survive the incremental merge or the reclaim below never runs.
    appendFileSync(
      forkPath,
      usageRecordRange(RESUMABLE_RECORDS + 2, RESUMABLE_RECORDS + 4),
      'utf-8'
    )
    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReadOffsets(forkPath)).toEqual([resumeOffset])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 4)
    expect(second.processedFiles.find((file) => file.path === forkPath)?.hasDeferredClaims).toBe(
      true
    )

    rmSync(originalPath)
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(third.processedFiles).toHaveLength(1)
    expect(third.processedFiles[0]?.ownedEventKeys).toHaveLength(RESUMABLE_RECORDS + 4)
    expect(totalTokens(third.dailyAggregates)).toBe(RESUMABLE_RECORDS + 4)
  })
})
