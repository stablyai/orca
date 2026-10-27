import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as JsonlLineOffsets from '../usage/jsonl-line-offsets'
import { join } from 'node:path'

const { getPathMock, homedirMock, streamReads, onStreamOpen, parsingPaths } = vi.hoisted(() => {
  const streamReads: { path: string; bytes: number; start: number; digest: boolean }[] = []
  // Inject filesystem mutations between parse reads.
  const onStreamOpen: { current: ((path: string, digest: boolean) => void) | null } = {
    current: null
  }
  return {
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    streamReads,
    onStreamOpen,
    parsingPaths: new Set<string>()
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

// Count both parsing and checkpoint reads for the scan I/O assertions.
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
      const read = { path: filePath, bytes: 0, start, digest: !parsingPaths.has(filePath) }
      streamReads.push(read)
      onStreamOpen.current?.(filePath, read.digest)
      const stream = actual.createReadStream(path, options)
      stream.on('data', (chunk: string | Buffer) => {
        read.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      })
      return stream
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const createStream = handle.createReadStream.bind(handle)
      const readWindow = handle.read.bind(handle)
      let streamActive = false
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        if (streamActive) {
          return readWindow(...readArgs)
        }
        const filePath = String(args[0])
        const digest = !parsingPaths.has(filePath)
        onStreamOpen.current?.(filePath, digest)
        const result = await readWindow(...readArgs)
        const position = readArgs.at(-1)
        streamReads.push({
          path: filePath,
          bytes: result.bytesRead,
          start: typeof position === 'number' ? position : 0,
          digest
        })
        return result
      })
      vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const filePath = String(args[0])
        const read = {
          path: filePath,
          bytes: 0,
          start: options?.start ?? 0,
          digest: !parsingPaths.has(filePath)
        }
        streamReads.push(read)
        onStreamOpen.current?.(filePath, read.digest)
        streamActive = true
        const stream = createStream(options)
        const finish = (): void => {
          streamActive = false
        }
        stream.once('end', finish)
        stream.once('close', finish)
        stream.on('data', (chunk: string | Buffer) => {
          read.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        })
        return stream
      })
      return handle
    }
  }
})

vi.mock('../usage/jsonl-line-offsets', async () => {
  const actual = await vi.importActual<typeof JsonlLineOffsets>('../usage/jsonl-line-offsets')
  return {
    ...actual,
    readJsonlLinesFromOffset: async function* (
      ...args: Parameters<typeof actual.readJsonlLinesFromOffset>
    ) {
      parsingPaths.add(args[0])
      try {
        yield* actual.readJsonlLinesFromOffset(...args)
      } finally {
        parsingPaths.delete(args[0])
      }
    }
  }
})

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  appendFileSync
} from 'node:fs'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsagePersistedFile } from './types'

/** Mirrors the checkpoint window in jsonl-file-checkpoint.ts. */
const BOUNDARY_WINDOW_BYTES = 4096

/** Clear the resumable-prefix floor so tests actually exercise incremental parsing. */
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

/** Each record contributes one token and advances the cumulative total. */
function usageRecordRange(from: number, to: number): string {
  let out = ''
  for (let index = from; index < to; index++) {
    const minute = String(index % 60).padStart(2, '0')
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

/** The iterator marks parse reads to distinguish them from bounded digest reads. */
function parseReadOffsets(filePath: string): number[] {
  return streamReads
    .filter((entry) => entry.path === filePath && !entry.digest)
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

/** Session attribution catches context corruption that token totals alone can miss. */
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
  parsingPaths.clear()
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

    // Allow checkpoint verification overhead as well as appended bytes.
    expect(reparsedFromStart(rolloutPath)).toBe(false)
    expect(bytesReadFor(rolloutPath)).toBeLessThan(sizeBeforeAppend)
    expect(bytesReadFor(rolloutPath)).toBeGreaterThan(appendedBytes)
    expect(bytesReadFor(rolloutPath)).toBeLessThanOrEqual(
      appendedBytes + 11 * BOUNDARY_WINDOW_BYTES
    )
  })

  it('carries cumulative token totals across the resume boundary', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-cumulative.jsonl')
    writeFileSync(
      rolloutPath,
      [
        sessionMeta('session-cumulative'),
        usageRecordRange(0, RESUMABLE_RECORDS),
        totalOnlyUsageRecord('2026-05-26T13:00:00.000Z', RESUMABLE_RECORDS + 100),
        totalOnlyUsageRecord('2026-05-26T13:01:00.000Z', RESUMABLE_RECORDS + 250)
      ].join(''),
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS + 250)
    const resumeOffset = recordedResumeOffset(first.processedFiles, rolloutPath)

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
    // Require a resumable prefix so fallback cannot pass trivially.
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    writeFileSync(rolloutPath, `${sessionMeta('session-truncated')}${usageRecordRange(0, 5)}`)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(5)
  })

  // Truncate after checkpoint validation to exercise the parse-time race.
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
    onStreamOpen.current = (path, digest) => {
      if (path === rolloutPath && !digest) {
        onStreamOpen.current = null
        writeFileSync(path, truncated, 'utf-8')
      }
    }

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(onStreamOpen.current).toBeNull()
    expect(parseReadOffsets(rolloutPath)).toEqual([resumeOffset, 0])
    expect(totalTokens(second.dailyAggregates)).toBe(5)
    expect(second.sessions[0]?.eventCount).toBe(5)
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(totalTokens(third.dailyAggregates)).toBe(5)
  })

  // Token totals can match despite a stale session context; compare attribution with a cold scan.
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
    expect(Buffer.byteLength(replacement)).toBeGreaterThan(resumeOffset)
    onStreamOpen.current = (path, digest) => {
      // Replace after discovery verification, while an earlier-sorted file is parsed.
      if (path === driverPath && !digest) {
        onStreamOpen.current = null
        writeFileSync(targetPath, replacement, 'utf-8')
      }
    }

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(onStreamOpen.current).toBeNull()
    expect(resumeOffset).toBeGreaterThan(0)
    expect(parseReadOffsets(targetPath)).toEqual([0])
    const fromScratch = await scanCodexUsageFiles([], [])

    expect(eventCountsBySession(second.sessions)).toEqual(
      eventCountsBySession(fromScratch.sessions)
    )
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  it('falls back to a full reparse when a rollout is rewritten at the same size', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-replaced.jsonl')
    const original = `${sessionMeta('session-a')}${usageRecordRange(0, RESUMABLE_RECORDS)}`
    writeFileSync(rolloutPath, original, 'utf-8')

    // Keep the rewrite observable on filesystems whose clock has not ticked yet.
    utimesSync(rolloutPath, 1, 1)
    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS)
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    const replacement = original.replaceAll('2026-05-26T', '2027-05-26T')
    expect(replacement.length).toBe(original.length)
    writeFileSync(rolloutPath, replacement, 'utf-8')
    expect(statSync(rolloutPath).size).toBe(original.length)

    expect(statSync(rolloutPath).mtimeMs).not.toBe(first.processedFiles[0]?.mtimeMs)
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

  /** Preserve the boundary window while changing leading records at the same file length. */
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
    // Only the boundary window can detect this rewrite.
    expect(original.length - sharedHead.length).toBeLessThan(BOUNDARY_WINDOW_BYTES)
    writeFileSync(rolloutPath, original, 'utf-8')

    // Keep the rewrite observable on filesystems whose clock has not ticked yet.
    utimesSync(rolloutPath, 1, 1)
    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(swappedTo)
    expect(recordedResumeOffset(first.processedFiles, rolloutPath)).toBeGreaterThan(0)

    writeFileSync(rolloutPath, replacement, 'utf-8')

    expect(statSync(rolloutPath).mtimeMs).not.toBe(first.processedFiles[0]?.mtimeMs)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(swappedFrom + 10 * 3)
  })

  // Recreated files can reuse inodes, so rotation must also check content.
  it('falls back to a full reparse when a recreated rollout swapped its prefix', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-prefix-swap-rotated.jsonl')
    const { original, replacement } = prefixSwapPair('session-prefix-rotated')
    writeFileSync(rolloutPath, original, 'utf-8')

    // Keep the rewrite observable on filesystems whose clock has not ticked yet.
    utimesSync(rolloutPath, 1, 1)
    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    rmSync(rolloutPath)
    writeFileSync(rolloutPath, replacement, 'utf-8')

    expect(statSync(rolloutPath).mtimeMs).not.toBe(first.processedFiles[0]?.mtimeMs)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(80)
  })

  it('falls back to a full reparse when a prefix was rewritten in place', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-prefix-swap-in-place.jsonl')
    const { original, replacement } = prefixSwapPair('session-prefix-in-place')
    writeFileSync(rolloutPath, original, 'utf-8')

    // Keep the rewrite observable on filesystems whose clock has not ticked yet.
    utimesSync(rolloutPath, 1, 1)
    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    const inodeBefore = statSync(rolloutPath).ino
    writeFileSync(rolloutPath, replacement, 'utf-8')
    expect(statSync(rolloutPath).ino).toBe(inodeBefore)

    expect(statSync(rolloutPath).mtimeMs).not.toBe(first.processedFiles[0]?.mtimeMs)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(80)
  })

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

    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-partial')}${complete}${pending}${usageRecordRange(RESUMABLE_RECORDS + 1, RESUMABLE_RECORDS + 2)}`,
      'utf-8'
    )

    streamReads.length = 0
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReadOffsets(rolloutPath)).toEqual([
      recordedResumeOffset(first.processedFiles, rolloutPath)
    ])
    expect(totalTokens(second.dailyAggregates)).toBe(RESUMABLE_RECORDS + 2)
    expect(second.sessions[0]?.eventCount).toBe(RESUMABLE_RECORDS + 2)
  })

  // Valid JSON without its newline is counted, so incremental reuse would count the tail twice.
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
    expect(totalTokens(first.dailyAggregates)).toBe(RESUMABLE_RECORDS + 1)
    expect(first.sessions[0]?.eventCount).toBe(RESUMABLE_RECORDS + 1)
    // A large prefix ensures the missing newline alone suppresses the checkpoint.
    expect(first.processedFiles[0]?.parseResumeState).toBeNull()

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
    // Simulate an append whose mtime is unchanged on a coarse-clock filesystem.
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
    // Shared prefix + two fork-only records + two appended records, each counted once.
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

  // Released ownership must let a fork count records lost from the rewritten file.
  it('lets a fork reclaim records a rewritten rollout can no longer own', async () => {
    const originalPath = join(sessionsDir, 'aaaa-rewritten.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-inheritor.jsonl')
    const sharedPrefix = `${sessionMeta('session-shared')}${usageRecordRange(0, 40)}`
    writeFileSync(originalPath, sharedPrefix, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

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
    // Appending must preserve the deferred flag so the fork can later reclaim the prefix.
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
