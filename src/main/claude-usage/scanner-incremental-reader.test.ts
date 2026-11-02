import { appendFile, mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { scanClaudeUsageFiles } from './scanner'
import type { ClaudeUsagePersistedFile } from './types'

type ReaderObservations = {
  chunkBytes: number | undefined
  afterStat: (() => Promise<void>) | undefined
  readFailure: 'eof' | Error | undefined
  readFailureAtCall: number | undefined
  streamEndOverride: number | undefined
  handles: { path: string; closes: number; closed: boolean }[]
  streams: { path: string; start: number; end: number | undefined; bytes: number }[]
  windows: { path: string; start: number; bytes: number }[]
}

const { homedirMock, reads } = vi.hoisted(() => {
  const reads: ReaderObservations = {
    chunkBytes: undefined,
    afterStat: undefined,
    readFailure: undefined,
    readFailureAtCall: undefined,
    streamEndOverride: undefined,
    handles: [],
    streams: [],
    windows: []
  }
  return { homedirMock: vi.fn<() => string>(), reads }
})

vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))

vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  claudeProfileHistoryDirs: () => []
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const observedHandle = { path: String(args[0]), closes: 0, closed: false }
      reads.handles.push(observedHandle)
      const statHandle = handle.stat.bind(handle)
      const closeHandle = handle.close.bind(handle)
      const createStream = handle.createReadStream.bind(handle)
      const readWindow = handle.read.bind(handle)
      let streaming = false
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const snapshot = await statHandle(options)
        const mutate = reads.afterStat
        reads.afterStat = undefined
        await mutate?.()
        return snapshot
      })
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await closeHandle()
        if (!observedHandle.closed && handle.fd === -1) {
          observedHandle.closes++
        }
        observedHandle.closed = handle.fd === -1
      })
      vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
        const read = {
          path: String(args[0]),
          start: options?.start ?? 0,
          end: options?.end,
          bytes: 0
        }
        reads.streams.push(read)
        const end = reads.streamEndOverride ?? options?.end
        reads.streamEndOverride = undefined
        const stream = createStream({ ...options, end, highWaterMark: reads.chunkBytes })
        streaming = true
        stream.once('end', () => (streaming = false))
        stream.once('close', () => (streaming = false))
        stream.on('data', (chunk: Buffer) => {
          read.bytes += chunk.length
        })
        return stream
      })
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        if (streaming) {
          return readWindow(...readArgs)
        }
        const scheduled =
          reads.readFailureAtCall === undefined ||
          reads.readFailureAtCall === reads.windows.length + 1
        const failure = scheduled ? reads.readFailure : undefined
        if (scheduled) {
          reads.readFailure = undefined
          reads.readFailureAtCall = undefined
        }
        if (failure && failure !== 'eof') {
          throw failure
        }
        const result = await readWindow(...readArgs)
        const read = failure === 'eof' ? { ...result, bytesRead: 0 } : result
        const position = readArgs.at(-1)
        reads.windows.push({
          path: String(args[0]),
          start: typeof position === 'number' ? position : 0,
          bytes: read.bytesRead
        })
        return read
      })
      return handle
    }
  }
})

type ScanResult = Awaited<ReturnType<typeof scanClaudeUsageFiles>>

let root: string
let transcriptPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-usage-reader-'))
  homedirMock.mockReturnValue(root)
  const projectDir = join(root, '.claude', 'projects', 'project-a')
  await mkdir(projectDir, { recursive: true })
  transcriptPath = join(projectDir, 'reader-session.jsonl')
  reads.chunkBytes = undefined
  reads.afterStat = undefined
  reads.readFailure = undefined
  reads.readFailureAtCall = undefined
  reads.streamEndOverride = undefined
  reads.handles.length = 0
  reads.streams.length = 0
  reads.windows.length = 0
  vi.resetModules()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function assistantRow(key: string | null, inputTokens: number, ending = '\n'): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: 'reader-会🙂',
    timestamp: '2026-10-09T12:00:00.000Z',
    cwd: join(root, 'workspace-会🙂'),
    requestId: key === null ? undefined : `request-${key}`,
    message: {
      id: key === null ? undefined : `message-${key}-会🙂`,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: inputTokens, output_tokens: 5 }
    }
  })}${ending}`
}

function padding(ending = '\n'): string {
  return `${JSON.stringify({ type: 'user', content: '界🙂'.repeat(2500) })}${ending}`
}

async function scan(previous: ClaudeUsagePersistedFile[] = []): Promise<ScanResult> {
  const { scanClaudeUsageFiles } = await import('./scanner')
  return scanClaudeUsageFiles([], previous, undefined, [])
}

function onlyFile(result: ScanResult): ClaudeUsagePersistedFile {
  expect(result.processedFiles).toHaveLength(1)
  const file = result.processedFiles[0]
  if (!file) {
    throw new Error('Expected one scanned transcript.')
  }
  return file
}

function expectParseRange(start: number, size: number): void {
  if (size <= 3 * 4096) {
    expect(reads.streams).toHaveLength(0)
    expect(reads.windows.slice(-2)).toEqual([
      { path: transcriptPath, start, bytes: size - start },
      { path: transcriptPath, start: 0, bytes: size }
    ])
    return
  }
  expect(reads.streams.filter((read) => read.path === transcriptPath)).toEqual([
    { path: transcriptPath, start, end: size - 1, bytes: size - start }
  ])
}

async function expectColdParity(result: ScanResult): Promise<void> {
  const cold = await scan()
  expect(result.sessions).toEqual(cold.sessions)
  expect(result.dailyAggregates).toEqual(cold.dailyAggregates)
  expect(onlyFile(result).lineCount).toBe(onlyFile(cold).lineCount)
}

describe('Claude usage incremental reader', () => {
  it('publishes the pinned snapshot and discovers a concurrent append on the next scan', async () => {
    const prefix = padding() + assistantRow('old', 10)
    const appended = assistantRow('new', 20)
    await writeFile(transcriptPath, prefix)
    reads.afterStat = () => appendFile(transcriptPath, appended)

    const first = await scan()

    expectParseRange(0, Buffer.byteLength(prefix))
    expect(onlyFile(first).size).toBe(Buffer.byteLength(prefix))
    expect(onlyFile(first).parseResumeState?.parsedBytes).toBe(Buffer.byteLength(prefix))
    expect((await stat(transcriptPath)).size).toBe(Buffer.byteLength(prefix + appended))
    expect(first.sessions[0]?.totalInputTokens).toBe(10)
    reads.streams.length = 0

    const second = await scan(first.processedFiles)

    expectParseRange(Buffer.byteLength(prefix), Buffer.byteLength(prefix + appended))
    expect(onlyFile(second).size).toBe(Buffer.byteLength(prefix + appended))
    expect(second.sessions[0]?.totalInputTokens).toBe(30)
    expect(second.sessions[0]?.turnCount).toBe(2)
    await expectColdParity(second)
  })

  it('reopens after truncation between stat and sampling and closes every opened handle', async () => {
    await writeFile(transcriptPath, padding() + assistantRow('old', 10))
    const replacement = assistantRow('replacement', 90)
    reads.afterStat = () => writeFile(transcriptPath, replacement)

    const result = await scan()

    expectParseRange(0, Buffer.byteLength(replacement))
    expect(reads.windows.some((read) => read.path === transcriptPath && read.bytes === 0)).toBe(
      true
    )
    expect(reads.handles).toEqual([
      { path: transcriptPath, closes: 1, closed: true },
      { path: transcriptPath, closes: 1, closed: true }
    ])
    expect(onlyFile(result).size).toBe(Buffer.byteLength(replacement))
    expect(result.sessions[0]?.totalInputTokens).toBe(90)
    await expectColdParity(result)
  }, 5000)

  it('rejects a short sample from an unchanged file once and closes its only handle', async () => {
    await writeFile(transcriptPath, padding() + assistantRow('old', 10))
    const original = await stat(transcriptPath)
    reads.readFailure = 'eof'

    await expect(scan()).rejects.toThrow(/snapshot read.*unchanged file boundary/)

    expect(reads.handles).toEqual([{ path: transcriptPath, closes: 1, closed: true }])
    expect(reads.windows).toEqual([{ path: transcriptPath, start: 0, bytes: 0 }])
    expect(reads.streams).toHaveLength(0)
    expect(await stat(transcriptPath)).toMatchObject({
      dev: original.dev,
      ino: original.ino,
      size: original.size,
      mtimeMs: original.mtimeMs,
      ctimeMs: original.ctimeMs
    })
  }, 5000)

  it('propagates a sampling access failure without retrying and closes its only handle', async () => {
    await writeFile(transcriptPath, padding() + assistantRow('old', 10))
    const failure = Object.assign(new Error('Sampling access denied'), { code: 'EACCES' })
    reads.readFailure = failure

    await expect(scan()).rejects.toBe(failure)

    expect(reads.handles).toEqual([{ path: transcriptPath, closes: 1, closed: true }])
    expect(reads.streams).toHaveLength(0)
  }, 5000)

  it('rejects a zero-byte post-parse verification read from an unchanged file without retrying', async () => {
    const content = padding() + assistantRow('old', 10) + assistantRow('new', 20)
    const contentBytes = Buffer.byteLength(content)
    await writeFile(transcriptPath, content)
    const original = await stat(transcriptPath)
    reads.readFailure = 'eof'
    reads.readFailureAtCall = 3

    await expect(scan()).rejects.toThrow(/snapshot read.*unchanged file boundary/)

    expectParseRange(0, contentBytes)
    expect(reads.windows).toEqual([
      { path: transcriptPath, start: 0, bytes: 4096 },
      { path: transcriptPath, start: contentBytes - 4096, bytes: 4096 },
      { path: transcriptPath, start: 0, bytes: 0 }
    ])
    expect(reads.handles).toEqual([{ path: transcriptPath, closes: 1, closed: true }])
    expect(await stat(transcriptPath)).toMatchObject({
      dev: original.dev,
      ino: original.ino,
      size: original.size,
      mtimeMs: original.mtimeMs,
      ctimeMs: original.ctimeMs
    })
    reads.streams.length = 0
    reads.handles.length = 0

    const cold = await scan()

    expectParseRange(0, contentBytes)
    expect(reads.handles).toEqual([{ path: transcriptPath, closes: 1, closed: true }])
    expect(onlyFile(cold).size).toBe(contentBytes)
    expect(onlyFile(cold).ownedDedupeKeys).toEqual([
      'message-old-会🙂:request-old',
      'message-new-会🙂:request-new'
    ])
    expect(onlyFile(cold).parseResumeState?.ownedTokenMaxima).toHaveLength(2)
    expect(cold.sessions[0]?.totalInputTokens).toBe(30)
    expect(cold.sessions[0]?.turnCount).toBe(2)
  }, 5000)

  it('rejects an unchanged large file stream that ends early instead of caching partial totals', async () => {
    const head = padding()
    const rows = Array.from({ length: 40 }, (_, index) => assistantRow(`row-${index}`, 10))
    const content = head + rows.join('')
    const partialContent = head + rows.slice(0, 5).join('')
    const contentBytes = Buffer.byteLength(content)
    const partialBytes = Buffer.byteLength(partialContent)
    await writeFile(transcriptPath, content)
    const original = await stat(transcriptPath)
    reads.streamEndOverride = partialBytes - 1

    await expect(scan()).rejects.toThrow(/snapshot stream.*unchanged file boundary/)

    expect(reads.handles).toEqual([{ path: transcriptPath, closes: 1, closed: true }])
    expect(reads.streams).toEqual([
      { path: transcriptPath, start: 0, end: contentBytes - 1, bytes: partialBytes }
    ])
    expect(reads.windows).toContainEqual({
      path: transcriptPath,
      start: contentBytes - 4096,
      bytes: 4096
    })
    expect(await stat(transcriptPath)).toMatchObject({
      dev: original.dev,
      ino: original.ino,
      size: original.size,
      mtimeMs: original.mtimeMs,
      ctimeMs: original.ctimeMs
    })
    reads.streams.length = 0
    reads.handles.length = 0

    const cold = await scan()

    expectParseRange(0, contentBytes)
    expect(reads.handles).toEqual([{ path: transcriptPath, closes: 1, closed: true }])
    expect(onlyFile(cold).size).toBe(contentBytes)
    expect(onlyFile(cold).parseResumeState?.parsedBytes).toBe(contentBytes)
    expect(onlyFile(cold).ownedDedupeKeys).toEqual(
      rows.map((_, index) => `message-row-${index}-会🙂:request-row-${index}`)
    )
    expect(onlyFile(cold).parseResumeState?.ownedTokenMaxima).toHaveLength(40)
    expect(onlyFile(cold).hasDeferredClaims).toBe(false)
    expect(cold.sessions[0]?.totalInputTokens).toBe(400)
    expect(cold.sessions[0]?.totalOutputTokens).toBe(200)
    expect(cold.sessions[0]?.turnCount).toBe(40)
  }, 5000)

  it('resumes at exact UTF8 byte offsets after CRLF and blank lines', async () => {
    reads.chunkBytes = 7
    const prefix = `${padding('\r\n')}${assistantRow('old', 10, '\r\n')}\r\n`
    await writeFile(transcriptPath, prefix)
    const first = await scan()
    const prefixBytes = Buffer.byteLength(prefix)
    expect(prefixBytes).toBeGreaterThan(prefix.length)
    expect(onlyFile(first).parseResumeState?.parsedBytes).toBe(prefixBytes)
    expect(onlyFile(first).parseResumeState?.lineCount).toBe(3)
    const appended = `${assistantRow('new', 20, '\r\n')}{"type":"user","text":"終🙂"}\r\n`
    await appendFile(transcriptPath, appended)
    reads.streams.length = 0
    reads.windows.length = 0

    const second = await scan(first.processedFiles)

    expectParseRange(prefixBytes, prefixBytes + Buffer.byteLength(appended))
    expect(reads.windows.some((read) => read.start === 0 && read.bytes === 4096)).toBe(true)
    expect(onlyFile(second).parseResumeState?.parsedBytes).toBe(
      prefixBytes + Buffer.byteLength(appended)
    )
    expect(onlyFile(second).lineCount).toBe(5)
    expect(second.sessions[0]?.sessionId).toBe('reader-会🙂')
    expect(second.sessions[0]?.totalInputTokens).toBe(30)
    expect(second.sessions[0]?.turnCount).toBe(2)
    await expectColdParity(second)
  })

  it('replays an incomplete UTF8 tail from the last complete line when it becomes valid', async () => {
    const prefix = padding('\r\n') + assistantRow('old', 10, '\r\n')
    const next = Buffer.from(assistantRow('completed', 20, '\r\n'))
    const split = next.indexOf(Buffer.from('🙂')) + 2
    await writeFile(transcriptPath, Buffer.concat([Buffer.from(prefix), next.subarray(0, split)]))
    const first = await scan()
    expect(onlyFile(first).parseResumeState?.parsedBytes).toBe(Buffer.byteLength(prefix))
    expect(onlyFile(first).parseResumeState?.lineCount).toBe(2)
    expect(onlyFile(first).lineCount).toBe(3)
    expect(first.sessions[0]?.totalInputTokens).toBe(10)
    await appendFile(transcriptPath, next.subarray(split))
    reads.streams.length = 0

    const second = await scan(first.processedFiles)

    expectParseRange(Buffer.byteLength(prefix), Buffer.byteLength(prefix) + next.length)
    expect(onlyFile(second).lineCount).toBe(3)
    expect(second.sessions[0]?.totalInputTokens).toBe(30)
    expect(second.sessions[0]?.turnCount).toBe(2)
    await expectColdParity(second)
  })

  it.each([
    { label: 'unkeyed turn', key: null, firstTotal: 35, nextTotal: 55, turns: 3 },
    { label: 'duplicate token maxima', key: 'old', firstTotal: 25, nextTotal: 45, turns: 2 }
  ])('counts a valid unterminated $label once when later terminated', async (testCase) => {
    const prefix = padding() + assistantRow('old', 10)
    const tail = assistantRow(testCase.key, 25, '')
    await writeFile(transcriptPath, prefix + tail)
    const first = await scan()
    expect(onlyFile(first).parseResumeState).toBeNull()
    expect(first.sessions[0]?.totalInputTokens).toBe(testCase.firstTotal)
    const appended = `\n${assistantRow('new', 20)}`
    await appendFile(transcriptPath, appended)
    reads.streams.length = 0

    const second = await scan(first.processedFiles)

    expectParseRange(0, Buffer.byteLength(prefix + tail + appended))
    expect(second.sessions[0]?.totalInputTokens).toBe(testCase.nextTotal)
    expect(second.sessions[0]?.turnCount).toBe(testCase.turns)
    await expectColdParity(second)
    const unchanged = await scan(second.processedFiles)
    expect(unchanged.sessions).toEqual(second.sessions)
    expect(unchanged.dailyAggregates).toEqual(second.dailyAggregates)
  })

  it('restores a JSON-persisted checkpoint after restart and resumes growth with unchanged mtime', async () => {
    const prefix = padding() + assistantRow('old', 10)
    const timestamp = new Date('2026-10-09T12:00:00.000Z')
    await writeFile(transcriptPath, prefix)
    await utimes(transcriptPath, timestamp, timestamp)
    const first = await scan()
    const persisted: ClaudeUsagePersistedFile[] = JSON.parse(JSON.stringify(first.processedFiles))
    const appended = assistantRow('old', 25) + assistantRow('new', 20)
    await appendFile(transcriptPath, appended)
    await utimes(transcriptPath, timestamp, timestamp)
    expect((await stat(transcriptPath)).mtimeMs).toBe(onlyFile(first).mtimeMs)
    vi.resetModules()
    reads.streams.length = 0

    const second = await scan(persisted)

    expectParseRange(Buffer.byteLength(prefix), Buffer.byteLength(prefix + appended))
    expect(second.sessions[0]?.totalInputTokens).toBe(45)
    expect(second.sessions[0]?.turnCount).toBe(2)
    await expectColdParity(second)
  })

  it('rebuilds an older cached projection without a resume checkpoint', async () => {
    const prefix = padding() + assistantRow('old', 10)
    await writeFile(transcriptPath, prefix)
    const first = await scan()
    const legacyFiles = first.processedFiles.map(({ parseResumeState, ...file }) => {
      expect(parseResumeState).toBeTruthy()
      return file
    })
    const appended = assistantRow('new', 20)
    await appendFile(transcriptPath, appended)
    reads.streams.length = 0

    const second = await scan(legacyFiles)

    expectParseRange(0, Buffer.byteLength(prefix + appended))
    expect(second.sessions[0]?.totalInputTokens).toBe(30)
    await expectColdParity(second)
  })

  it.each([
    { change: 'an unchanged file', total: 10 },
    { change: 'an atomic same-size replacement', total: 90 }
  ])('upgrades legacy identity metadata once for $change', async ({ change, total }) => {
    const timestamp = new Date('2026-10-09T12:00:00.000Z')
    const prefix = padding()
    const original = prefix + assistantRow('old', 10)
    await writeFile(transcriptPath, original)
    await utimes(transcriptPath, timestamp, timestamp)
    const first = await scan()
    const legacyFiles = first.processedFiles.map(({ physicalFileId, ctimeMs, ...file }) => {
      expect(physicalFileId).not.toBeUndefined()
      expect(typeof ctimeMs).toBe('number')
      return file
    })
    if (change === 'an atomic same-size replacement') {
      const replacement = prefix + assistantRow('new', 90)
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
      const replacementPath = `${transcriptPath}.replacement`
      await writeFile(replacementPath, replacement)
      await utimes(replacementPath, timestamp, timestamp)
      await rename(replacementPath, transcriptPath)
    }
    const currentStats = await stat(transcriptPath)
    expect(currentStats.size).toBe(onlyFile(first).size)
    expect(currentStats.mtimeMs).toBe(onlyFile(first).mtimeMs)
    reads.streams.length = 0

    const upgraded = await scan(legacyFiles)

    expectParseRange(0, Buffer.byteLength(original))
    expect(onlyFile(upgraded).physicalFileId).not.toBeUndefined()
    expect(typeof onlyFile(upgraded).ctimeMs).toBe('number')
    expect(upgraded.sessions[0]?.totalInputTokens).toBe(total)
    await expectColdParity(upgraded)
    reads.streams.length = 0
    reads.windows.length = 0
    reads.handles.length = 0

    const unchanged = await scan(upgraded.processedFiles)

    expect(onlyFile(unchanged)).toBe(onlyFile(upgraded))
    expect(reads.streams).toHaveLength(0)
    expect(reads.windows).toHaveLength(0)
    expect(reads.handles).toHaveLength(0)
  })

  it.each([
    { mutation: 'rotation', layout: 'small' },
    { mutation: 'in-place rewrite', layout: 'small' },
    { mutation: 'rotation', layout: 'large' },
    { mutation: 'in-place rewrite', layout: 'large middle' }
  ])(
    'invalidates a $layout file after same-size $mutation with restored mtime',
    async ({ mutation, layout }) => {
      const timestamp = new Date('2026-10-09T12:00:00.000Z')
      const prefix = layout === 'small' ? '' : padding()
      const suffix = layout === 'large middle' ? padding() : ''
      const original = prefix + assistantRow('old', 10) + suffix
      const replacement = prefix + assistantRow('new', 90) + suffix
      expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
      await writeFile(transcriptPath, original)
      await utimes(transcriptPath, timestamp, timestamp)
      const first = await scan()
      const cached = onlyFile(first)
      if (layout === 'small') {
        expect(cached.parseResumeState).toBeNull()
      } else {
        expect(cached.parseResumeState).toBeTruthy()
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (mutation === 'rotation') {
        await rename(transcriptPath, `${transcriptPath}.rotated`)
      }
      await writeFile(transcriptPath, replacement)
      await utimes(transcriptPath, timestamp, timestamp)
      const rewritten = await stat(transcriptPath)
      expect(rewritten.size).toBe(cached.size)
      expect(rewritten.mtimeMs).toBe(cached.mtimeMs)
      expect(rewritten.ctimeMs).not.toBe(cached.ctimeMs)
      reads.streams.length = 0

      const second = await scan(first.processedFiles)

      expectParseRange(0, Buffer.byteLength(replacement))
      expect(second.sessions[0]?.totalInputTokens).toBe(90)
      const current = onlyFile(second)
      if (mutation === 'rotation' && cached.physicalFileId !== null) {
        expect(current.physicalFileId).not.toBe(cached.physicalFileId)
      } else {
        expect(current.physicalFileId).toBe(cached.physicalFileId)
      }
      await expectColdParity(second)
    }
  )

  it.each([
    { mutation: 'head rewrite', total: 140 },
    { mutation: 'boundary rewrite', total: 100 },
    { mutation: 'rotation', total: 50 },
    { mutation: 'truncation', total: 50 }
  ])('discards stale totals after $mutation', async ({ mutation, total }) => {
    const prefix = assistantRow('old', 10) + padding() + assistantRow('second', 30)
    await writeFile(transcriptPath, prefix)
    const first = await scan()
    expect(onlyFile(first).parseResumeState).toBeTruthy()
    let replacement: string
    if (mutation === 'rotation') {
      await rename(transcriptPath, `${transcriptPath}.rotated`)
      replacement = assistantRow('replacement', 50)
    } else if (mutation === 'truncation') {
      replacement = assistantRow('replacement', 50)
    } else {
      replacement =
        prefix.replace(
          mutation === 'head rewrite' ? '"input_tokens":10' : '"input_tokens":30',
          mutation === 'head rewrite' ? '"input_tokens":90' : '"input_tokens":70'
        ) + assistantRow('new', 20)
    }
    await writeFile(transcriptPath, replacement)
    reads.streams.length = 0

    const second = await scan(first.processedFiles)

    expectParseRange(0, Buffer.byteLength(replacement))
    expect(second.sessions[0]?.totalInputTokens).toBe(total)
    await expectColdParity(second)
  })
})
