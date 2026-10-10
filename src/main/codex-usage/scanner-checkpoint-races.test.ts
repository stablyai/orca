import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { homedirMock, getPathMock, parseReads, handles, mutation } = vi.hoisted(() => {
  const parseReads: { path: string; start: number; bytes: number }[] = []
  const mutation: {
    beforeParse: ((path: string) => void) | null
    duringParse: ((path: string) => void) | null
    endBeforeEOF: number | null
    zeroDescriptorRead: boolean
  } = {
    beforeParse: null,
    duringParse: null,
    endBeforeEOF: null,
    zeroDescriptorRead: false
  }
  return {
    homedirMock: vi.fn<() => string>(),
    getPathMock: vi.fn<(name: string) => string>(),
    parseReads,
    handles: { opened: 0, closed: 0 },
    mutation
  }
})

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      handles.opened++
      const createStream = handle.createReadStream.bind(handle)
      const readDescriptor = handle.read.bind(handle)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await readDescriptor(...readArgs)
        if (mutation.zeroDescriptorRead) {
          mutation.zeroDescriptorRead = false
          return { ...result, bytesRead: 0 }
        }
        return result
      })
      let closed = false
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        if (!closed) {
          closed = true
          handles.closed++
        }
      })
      vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const start = options?.start ?? 0
        const end = options?.end
        const parseRead = end !== undefined && end - start + 1 !== 4096
        const filePath = String(args[0])
        if (parseRead) {
          mutation.beforeParse?.(filePath)
        }
        const forcedEnd = parseRead ? mutation.endBeforeEOF : null
        if (forcedEnd !== null) {
          mutation.endBeforeEOF = null
        }
        const stream = createStream(forcedEnd === null ? options : { ...options, end: forcedEnd })
        if (parseRead) {
          const read = { path: filePath, start, bytes: 0 }
          parseReads.push(read)
          stream.on('data', (chunk: string | Buffer) => {
            read.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          })
          stream.once('data', () => mutation.duringParse?.(filePath))
        }
        return stream
      })
      return handle
    }
  }
})

import { parseCodexUsageFile } from './codex-rollout-file-parse'
import { scanCodexUsageFiles } from './scanner'

let root: string
let rolloutPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-checkpoint-races-'))
  homedirMock.mockReturnValue(root)
  getPathMock.mockReturnValue(join(root, 'user-data'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
  vi.stubEnv('XDG_CONFIG_HOME', join(root, '.config'))
  vi.stubEnv('CODEX_HOME', join(root, '.codex'))
  const sessions = join(root, '.codex', 'sessions')
  mkdirSync(sessions, { recursive: true })
  rolloutPath = join(sessions, 'rollout.jsonl')
  parseReads.length = 0
  handles.opened = 0
  handles.closed = 0
  mutation.beforeParse = null
  mutation.duringParse = null
  mutation.endBeforeEOF = null
  mutation.zeroDescriptorRead = false
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  expect(handles.closed).toBe(handles.opened)
})

function record(index: number, baseline: number): string {
  return `${JSON.stringify({
    timestamp: `2026-05-26T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        last_token_usage: { input_tokens: 1, total_tokens: 1 },
        total_token_usage: {
          input_tokens: baseline + index + 1,
          total_tokens: baseline + index + 1
        }
      }
    }
  })}\n`
}

function records(from: number, to: number, baseline = 1000): string {
  return Array.from({ length: to - from }, (_, index) => record(from + index, baseline)).join('')
}

function transcript(sessionId: string, count: number, baseline = 1000): string {
  const metadata = `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: root } })}\n`
  const padding = `${JSON.stringify({ type: 'tool-result', content: 'x'.repeat(16_384) })}\n`
  return metadata + padding + records(0, count, baseline)
}

function offsets(): number[] {
  return parseReads.filter((read) => read.path === rolloutPath).map((read) => read.start)
}

describe('Codex checkpoint file races', () => {
  it.each(['rewrite', 'rotate'])(
    'discards a %s after verification before reading the suffix',
    async (kind) => {
      writeFileSync(rolloutPath, transcript('session-old', 40))
      const first = await scanCodexUsageFiles([], [])
      const offset = first.processedFiles[0]?.parseResumeState?.parsedBytes ?? 0
      expect(offset).toBeGreaterThan(12_288)
      appendFileSync(rolloutPath, records(40, 42))
      const replacement = transcript('session-new', 60, 2000)
      mutation.beforeParse = (filePath) => {
        mutation.beforeParse = null
        if (kind === 'rotate') {
          const replacementPath = join(root, 'replacement.jsonl')
          writeFileSync(replacementPath, replacement)
          renameSync(replacementPath, filePath)
        } else {
          writeFileSync(filePath, replacement)
        }
      }
      parseReads.length = 0

      const second = await scanCodexUsageFiles([], first.processedFiles)
      expect(mutation.beforeParse).toBeNull()
      expect(offsets()).toEqual([offset, 0])
      expect(parseReads.every((read) => read.bytes > 0)).toBe(true)
      const cold = await scanCodexUsageFiles([], [])
      expect(second.sessions).toEqual(cold.sessions)
      expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
      expect(second.sessions[0]?.sessionId).toBe('session-new')
      const third = await scanCodexUsageFiles([], second.processedFiles)
      expect(third.processedFiles[0]).toBe(second.processedFiles[0])
      expect(third.sessions).toEqual(cold.sessions)
    }
  )

  it('discards cold-read events before claiming their keys when the file changes during parsing', async () => {
    writeFileSync(rolloutPath, transcript('session-old', 40))
    mutation.duringParse = (filePath) => {
      mutation.duringParse = null
      writeFileSync(filePath, transcript('session-new', 60, 2000))
    }
    const commitEventKey = vi.fn()

    const parsed = await parseCodexUsageFile(rolloutPath, () => null, { commitEventKey })
    expect(offsets()).toEqual([0, 0])
    expect(parsed.sessions[0]?.sessionId).toBe('session-new')
    expect(parsed.sessions[0]?.eventCount).toBe(60)
    expect(commitEventKey).toHaveBeenCalledTimes(60)
    const cold = await parseCodexUsageFile(rolloutPath, () => null)
    expect(parsed.ownedEventKeys).toEqual(cold.ownedEventKeys)
    expect(parsed.sessions).toEqual(cold.sessions)
  })

  it('leaves an append after the captured EOF for the next scan', async () => {
    writeFileSync(rolloutPath, transcript('session-stable', 40))
    const capturedSize = statSync(rolloutPath).size
    mutation.duringParse = (filePath) => {
      mutation.duringParse = null
      appendFileSync(filePath, records(40, 41))
    }

    const first = await scanCodexUsageFiles([], [])
    expect(first.sessions[0]?.eventCount).toBe(40)
    expect(first.processedFiles[0]?.size).toBe(capturedSize)
    expect(first.processedFiles[0]?.parseResumeState?.parsedBytes).toBe(capturedSize)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(second.sessions[0]?.eventCount).toBe(41)
    const cold = await scanCodexUsageFiles([], [])
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
  })

  it('releases old owner claims and lets an unchanged deferred fork reclaim them', async () => {
    const prefix = transcript('session-old', 40)
    const forkPath = join(dirname(rolloutPath), 'zzzz-fork.jsonl')
    writeFileSync(rolloutPath, prefix)
    writeFileSync(forkPath, prefix + records(40, 41))
    const first = await scanCodexUsageFiles([], [])
    const fork = first.processedFiles.find((file) => file.path === forkPath)
    expect(fork?.hasDeferredClaims).toBe(true)
    expect(fork?.ownedEventKeys).toHaveLength(1)
    appendFileSync(rolloutPath, records(40, 42))
    mutation.beforeParse = (filePath) => {
      if (filePath === rolloutPath) {
        mutation.beforeParse = null
        writeFileSync(filePath, transcript('session-new', 60, 2000))
      }
    }
    parseReads.length = 0

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(parseReads.filter((read) => read.path === forkPath).map((read) => read.start)).toEqual([
      0
    ])
    expect(
      second.processedFiles.find((file) => file.path === forkPath)?.ownedEventKeys
    ).toHaveLength(41)
    const cold = await scanCodexUsageFiles([], [])
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(third.sessions).toEqual(cold.sessions)
  })

  it('keeps an unchanged deferred fork cached when a short owner merely appends', async () => {
    const prefix = records(0, 3)
    const forkPath = join(dirname(rolloutPath), 'zzzz-fork.jsonl')
    writeFileSync(rolloutPath, prefix)
    writeFileSync(forkPath, prefix + records(3, 4))
    const first = await scanCodexUsageFiles([], [])
    const fork = first.processedFiles.find((file) => file.path === forkPath)
    expect(fork?.hasDeferredClaims).toBe(true)
    expect(first.processedFiles[0]?.parseResumeState).toBeNull()
    appendFileSync(rolloutPath, records(4, 5))
    parseReads.length = 0

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(second.processedFiles.find((file) => file.path === forkPath)).toBe(fork)
    expect(parseReads.some((read) => read.path === forkPath)).toBe(false)
    expect(second.dailyAggregates.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(5)
  })

  it('rejects an unchanged file stream that stops early before claiming partial history', async () => {
    writeFileSync(rolloutPath, transcript('session-stable', 40))
    mutation.endBeforeEOF = Buffer.byteLength(transcript('session-stable', 10)) - 1
    const commitEventKey = vi.fn()

    await expect(parseCodexUsageFile(rolloutPath, () => null, { commitEventKey })).rejects.toThrow(
      'JSONL snapshot stream ended before the unchanged file boundary.'
    )
    expect(mutation.endBeforeEOF).toBeNull()
    expect(offsets()).toEqual([0])
    expect(commitEventKey).not.toHaveBeenCalled()
    const cold = await scanCodexUsageFiles([], [])
    expect(cold.sessions[0]?.eventCount).toBe(40)
  })

  it('leaves the previous scan intact when an unchanged suffix stream stops early', async () => {
    const prefix = transcript('session-stable', 40)
    writeFileSync(rolloutPath, prefix)
    const previous = await scanCodexUsageFiles([], [])
    appendFileSync(rolloutPath, records(40, 42))
    mutation.endBeforeEOF = Buffer.byteLength(prefix + records(40, 41)) - 1
    parseReads.length = 0

    await expect(scanCodexUsageFiles([], previous.processedFiles)).rejects.toThrow(
      'JSONL snapshot stream ended before the unchanged file boundary.'
    )
    expect(mutation.endBeforeEOF).toBeNull()
    expect(offsets()).toEqual([Buffer.byteLength(prefix)])
    expect(previous.sessions[0]?.eventCount).toBe(40)
    expect(previous.processedFiles[0]?.size).toBe(Buffer.byteLength(prefix))
    const recovered = await scanCodexUsageFiles([], previous.processedFiles)
    expect(recovered.sessions[0]?.eventCount).toBe(42)
  })

  it('rejects a stable zero-byte read of the skipped prefix in a short legacy source', async () => {
    writeFileSync(rolloutPath, records(0, 3))
    mutation.zeroDescriptorRead = true
    const commitEventKey = vi.fn()
    const legacySourceSkipBytes = Buffer.byteLength(records(0, 1))

    await expect(
      parseCodexUsageFile(rolloutPath, () => null, { legacySourceSkipBytes, commitEventKey })
    ).rejects.toThrow('JSONL snapshot read ended before the unchanged file boundary.')
    expect(mutation.zeroDescriptorRead).toBe(false)
    expect(offsets()).toEqual([])
    expect(commitEventKey).not.toHaveBeenCalled()
    const recovered = await parseCodexUsageFile(rolloutPath, () => null, { legacySourceSkipBytes })
    expect(recovered.sessions[0]?.eventCount).toBe(2)
  })
})
