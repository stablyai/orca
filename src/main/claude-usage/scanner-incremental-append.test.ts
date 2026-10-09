import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock, streamReads } = vi.hoisted(() => {
  const streamReads: { path: string; start: number; bytes: number }[] = []
  return { homedirMock: vi.fn<() => string>(), streamReads }
})

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    createReadStream: (
      path: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1]
    ) => {
      const range = typeof options === 'object' && options !== null ? options : {}
      const read = { path: String(path), start: range.start ?? 0, bytes: 0 }
      streamReads.push(read)
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
      let streaming = false
      vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const read = { path: String(args[0]), start: options?.start ?? 0, bytes: 0 }
        streamReads.push(read)
        const stream = createStream(options)
        streaming = true
        stream.once('end', () => (streaming = false))
        stream.once('close', () => (streaming = false))
        stream.on('data', (chunk: string | Buffer) => {
          read.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        })
        return stream
      })
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const streamRead = streaming
        const result = await readWindow(...readArgs)
        if (streamRead) {
          return result
        }
        const position = readArgs.at(-1)
        streamReads.push({
          path: String(args[0]),
          start: typeof position === 'number' ? position : 0,
          bytes: result.bytesRead
        })
        return result
      })
      return handle
    }
  }
})

let root: string
let transcriptPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-usage-append-'))
  homedirMock.mockReturnValue(root)
  const projectDir = join(root, '.claude', 'projects', 'project-a')
  await mkdir(projectDir, { recursive: true })
  transcriptPath = join(projectDir, 'active-session.jsonl')
  streamReads.length = 0
  vi.resetModules()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function usageRecord(index: number, inputTokens = 100, cacheReadTokens = 0): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'active-session',
    timestamp: `2026-10-09T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
    requestId: `request-${index}`,
    cwd: join(root, 'repo'),
    message: {
      id: `message-${index}`,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: inputTokens,
        output_tokens: 10,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: 20,
        cache_creation: { ephemeral_1h_input_tokens: 5 }
      }
    }
  })}\n`
}

function prefixRecords(): string {
  const toolResult = `${JSON.stringify({ type: 'user', content: '界'.repeat(350_000) })}\n`
  return toolResult + Array.from({ length: 80 }, (_, index) => usageRecord(index)).join('')
}

function streamedBytes(): number {
  return streamReads
    .filter((read) => read.path === transcriptPath)
    .reduce((sum, read) => sum + read.bytes, 0)
}

describe('Claude usage append scans', () => {
  it('reads appended usage without rereading the transcript history', async () => {
    const prefix = prefixRecords()
    await writeFile(transcriptPath, prefix)
    const { scanClaudeUsageFiles } = await import('./scanner')
    const first = await scanClaudeUsageFiles([], [], undefined, [])
    const appended = usageRecord(80)
    await appendFile(transcriptPath, appended)
    streamReads.length = 0

    const second = await scanClaudeUsageFiles([], first.processedFiles, undefined, [])
    const appendBytes = streamedBytes()
    const cold = await scanClaudeUsageFiles([], [], undefined, [])

    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(second.processedFiles[0]?.lineCount).toBe(82)
    expect(second.sessions[0]?.turnCount).toBe(81)
    expect(appendBytes).toBeLessThan(Buffer.byteLength(prefix) / 10)
  })

  it('updates a previously counted assistant row with its later token maxima', async () => {
    await writeFile(transcriptPath, prefixRecords())
    const { scanClaudeUsageFiles } = await import('./scanner')
    const first = await scanClaudeUsageFiles([], [], undefined, [])
    await appendFile(transcriptPath, usageRecord(3, 250, 40) + usageRecord(80))

    const second = await scanClaudeUsageFiles([], first.processedFiles, undefined, [])
    const cold = await scanClaudeUsageFiles([], [], undefined, [])

    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(second.sessions[0]?.turnCount).toBe(81)
    expect(second.sessions[0]?.totalInputTokens).toBe(8_250)
    expect(second.sessions[0]?.totalCacheReadTokens).toBe(40)
    expect(second.dailyAggregates[0]?.zeroCacheReadTurnCount).toBe(80)
  })
})
