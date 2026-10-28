import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedFile } from './types'
import type { ClaudeUsageWorktreeRef } from './worktree-attribution'

const { homedirMock, streamReads } = vi.hoisted(() => {
  const streamReads: { path: string; start: number; checkpointWindow: boolean; bytes: number }[] =
    []
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
      return observeReadStream(
        String(path),
        range.start ?? 0,
        range.end,
        actual.createReadStream(path, options)
      )
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2]
    ) => {
      const handle = await actual.open(path, flags, mode)
      const createReadStream = handle.createReadStream.bind(handle)
      handle.createReadStream = (options) =>
        observeReadStream(
          String(path),
          options?.start ?? 0,
          options?.end,
          createReadStream(options)
        )
      return handle
    }
  }
})

function observeReadStream(
  path: string,
  start: number,
  end: number | undefined,
  stream: NodeFs.ReadStream
): NodeFs.ReadStream {
  const read = {
    path,
    start,
    checkpointWindow: end !== undefined && end - start + 1 === 4096,
    bytes: 0
  }
  streamReads.push(read)
  stream.on('data', (chunk: string | Buffer) => {
    read.bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
  })
  return stream
}

type AssistantRowOptions = {
  identified?: boolean
  sessionId?: string
  timestamp?: string
  model?: string
  cwd?: string
  gitBranch?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheWrite1hTokens?: number
}

let root: string
let projectDir: string
let worktrees: ClaudeUsageWorktreeRef[]

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-append-ownership-'))
  homedirMock.mockReturnValue(root)
  projectDir = join(root, '.claude', 'projects', 'project-a')
  worktrees = ['a', 'b'].map((id) => ({
    repoId: `repo-${id}`,
    worktreeId: `worktree-${id}`,
    path: join(root, `workspace-${id}`),
    displayName: `Workspace ${id.toUpperCase()}`
  }))
  await Promise.all([
    mkdir(projectDir, { recursive: true }),
    ...worktrees.map((worktree) => mkdir(worktree.path))
  ])
  streamReads.length = 0
  vi.resetModules()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function assistantRow(key: string, options: AssistantRowOptions = {}): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: options.sessionId ?? 'owner-session',
    timestamp: options.timestamp ?? '2026-10-09T12:00:00.000Z',
    cwd: options.cwd ?? worktrees[0]?.path,
    gitBranch: options.gitBranch ?? 'original-branch',
    requestId: options.identified === false ? undefined : `request-${key}`,
    message: {
      id: options.identified === false ? undefined : `message-${key}`,
      model: options.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: options.inputTokens ?? 10,
        output_tokens: options.outputTokens ?? 0,
        cache_read_input_tokens: options.cacheReadTokens ?? 0,
        cache_creation_input_tokens: options.cacheWriteTokens ?? 0,
        cache_creation: { ephemeral_1h_input_tokens: options.cacheWrite1hTokens ?? 0 }
      }
    }
  })}\n`
}

function largePrefix(label = 'original'): string {
  // Tool-result padding clears the resume floor without introducing extra billable turns.
  return `${JSON.stringify({ type: 'user', label, content: '界'.repeat(12_000) })}\n`
}

function processedFile(files: ClaudeUsagePersistedFile[], path: string): ClaudeUsagePersistedFile {
  const file = files.find((candidate) => candidate.path === path)
  if (!file) {
    throw new Error(`Expected a scanned file at ${path}`)
  }
  return file
}

function parseReadOffsets(path: string): number[] {
  return streamReads
    .filter((read) => read.path === path && !read.checkpointWindow && read.bytes > 0)
    .map((read) => read.start)
}

async function scanner() {
  const { scanClaudeUsageFiles } = await import('./scanner')
  return (previous: ClaudeUsagePersistedFile[] = []) =>
    scanClaudeUsageFiles(worktrees, previous, undefined, [])
}

describe('Claude usage append ownership', () => {
  it.each([
    { kind: 'object', keys: { copiedKey: 'message-streamed:request-streamed' } },
    { kind: 'string', keys: 'message-streamed:request-streamed' }
  ])(
    'reparses persisted ownership keys stored as a $kind without reserving invalid claims',
    async ({ keys }) => {
      const ownerPath = join(projectDir, 'aaaa-damaged-owner.jsonl')
      const forkPath = join(projectDir, 'zzzz-late-fork.jsonl')
      await writeFile(ownerPath, largePrefix() + assistantRow('streamed', { inputTokens: 100 }))
      const scan = await scanner()
      const first = await scan()
      const cached: ClaudeUsagePersistedFile[] = JSON.parse(JSON.stringify(first.processedFiles))
      Reflect.set(processedFile(cached, ownerPath), 'ownedDedupeKeys', keys)
      await appendFile(ownerPath, assistantRow('streamed', { inputTokens: 150 }))
      await writeFile(
        forkPath,
        largePrefix() +
          assistantRow('streamed', { sessionId: 'fork-session', inputTokens: 100 }) +
          assistantRow('fork-new', { sessionId: 'fork-session', inputTokens: 50 })
      )
      streamReads.length = 0

      const second = await scan(cached)
      expect(parseReadOffsets(ownerPath)).toEqual([0])
      const cold = await scan()
      expect(second.sessions).toEqual(cold.sessions)
      expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
      expect(processedFile(second.processedFiles, ownerPath).ownedDedupeKeys).toEqual([
        'message-streamed:request-streamed'
      ])
      expect(processedFile(second.processedFiles, forkPath).ownedDedupeKeys).toEqual([
        'message-fork-new:request-fork-new'
      ])
      expect(second.sessions.reduce((total, session) => total + session.totalInputTokens, 0)).toBe(
        200
      )
    }
  )

  it.each([
    'ownedTokenMaxima',
    'encounterOrder',
    'missingProjections',
    'invalidProjectionIndex',
    'outOfRangeProjectionIndex'
  ] as const)(
    'reparses a persisted checkpoint with damaged %s instead of extending an inconsistent projection',
    async (missingField) => {
      const transcriptPath = join(projectDir, 'damaged-checkpoint.jsonl')
      await writeFile(
        transcriptPath,
        largePrefix() + assistantRow('streamed', { inputTokens: 100 })
      )
      const scan = await scanner()
      const first = await scan()
      const cached: ClaudeUsagePersistedFile[] = JSON.parse(JSON.stringify(first.processedFiles))
      const checkpoint = processedFile(cached, transcriptPath).parseResumeState
      if (!checkpoint) {
        throw new Error('Expected a resumable transcript before damaging its checkpoint')
      }
      if (missingField === 'missingProjections') {
        Reflect.deleteProperty(checkpoint, 'projections')
      } else if (
        missingField === 'invalidProjectionIndex' ||
        missingField === 'outOfRangeProjectionIndex'
      ) {
        const maxima = checkpoint.ownedTokenMaxima[0]
        if (!maxima) {
          throw new Error('Expected retained token maxima before damaging their projection index')
        }
        maxima[5] = missingField === 'invalidProjectionIndex' ? 0.5 : checkpoint.projections.length
      } else {
        checkpoint[missingField] = []
      }
      await appendFile(transcriptPath, assistantRow('streamed', { inputTokens: 150 }))
      streamReads.length = 0

      const second = await scan(cached)
      expect(parseReadOffsets(transcriptPath)).toEqual([0])
      const cold = await scan()
      expect(second.sessions).toEqual(cold.sessions)
      expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
      expect(second.sessions[0]?.turnCount).toBe(1)
      expect(second.sessions[0]?.totalInputTokens).toBe(150)
    }
  )

  it('keeps a large unchanged deferred fork cached when its small owner only appends', async () => {
    const ownerPath = join(projectDir, 'aaaa-small-owner.jsonl')
    const forkPath = join(projectDir, 'zzzz-large-deferred-fork.jsonl')
    await writeFile(ownerPath, assistantRow('shared', { inputTokens: 100 }))
    await writeFile(
      forkPath,
      `${JSON.stringify({ type: 'user', content: '界'.repeat(350_000) })}\n${assistantRow(
        'shared',
        {
          sessionId: 'fork-session',
          inputTokens: 100
        }
      )}`
    )
    const scan = await scanner()
    const first = await scan()
    const cachedFork = processedFile(first.processedFiles, forkPath)
    expect(cachedFork.hasDeferredClaims).toBe(true)
    expect(cachedFork.size).toBeGreaterThan(1_000_000)
    expect(processedFile(first.processedFiles, ownerPath).parseResumeState).toBeNull()
    await appendFile(ownerPath, assistantRow('owner-new', { inputTokens: 50 }))
    streamReads.length = 0

    const second = await scan(first.processedFiles)
    expect(processedFile(second.processedFiles, forkPath)).toBe(cachedFork)
    expect(streamReads.filter((read) => read.path === forkPath)).toEqual([])
    const cold = await scan()
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(second.sessions[0]?.turnCount).toBe(2)
    expect(second.sessions[0]?.totalInputTokens).toBe(150)
  })

  it('retains a resumed owner when a fork of its earlier history appears', async () => {
    const ownerPath = join(projectDir, 'aaaa-owner.jsonl')
    const forkPath = join(projectDir, 'zzzz-late-fork.jsonl')
    await writeFile(ownerPath, largePrefix() + assistantRow('shared'))
    const scan = await scanner()
    const first = await scan()
    const ownerOffset = processedFile(first.processedFiles, ownerPath).size

    await appendFile(ownerPath, assistantRow('owner-new', { inputTokens: 20 }))
    await writeFile(
      forkPath,
      largePrefix() +
        assistantRow('shared', { sessionId: 'fork-session' }) +
        assistantRow('fork-new', { sessionId: 'fork-session', inputTokens: 30 })
    )
    streamReads.length = 0
    const second = await scan(first.processedFiles)
    expect(parseReadOffsets(ownerPath)).toEqual([ownerOffset])
    expect(processedFile(second.processedFiles, ownerPath).ownedDedupeKeys).toEqual([
      'message-shared:request-shared',
      'message-owner-new:request-owner-new'
    ])
    expect(processedFile(second.processedFiles, forkPath).ownedDedupeKeys).toEqual([
      'message-fork-new:request-fork-new'
    ])
    expect(processedFile(second.processedFiles, forkPath).hasDeferredClaims).toBe(true)

    const cold = await scan()
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(second.sessions.map((session) => [session.sessionId, session.turnCount])).toEqual([
      ['owner-session', 2],
      ['fork-session', 1]
    ])
  })

  it('reclaims copied turns after a deferred fork resumes and its owner is deleted', async () => {
    const ownerPath = join(projectDir, 'aaaa-owner.jsonl')
    const forkPath = join(projectDir, 'zzzz-deferred-fork.jsonl')
    await writeFile(ownerPath, largePrefix() + assistantRow('shared'))
    await writeFile(
      forkPath,
      largePrefix() +
        assistantRow('shared', { sessionId: 'fork-session' }) +
        assistantRow('fork-new', { sessionId: 'fork-session', inputTokens: 20 })
    )
    const scan = await scanner()
    const first = await scan()
    const forkOffset = processedFile(first.processedFiles, forkPath).size

    await appendFile(
      forkPath,
      assistantRow('fork-later', { sessionId: 'fork-session', inputTokens: 30 })
    )
    streamReads.length = 0
    const second = await scan(first.processedFiles)
    expect(parseReadOffsets(forkPath)).toEqual([forkOffset])
    expect(processedFile(second.processedFiles, forkPath).hasDeferredClaims).toBe(true)

    await rm(ownerPath)
    const third = await scan(second.processedFiles)
    const cold = await scan()
    expect(third.sessions).toEqual(cold.sessions)
    expect(third.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(third.sessions[0]?.turnCount).toBe(3)
    expect(third.sessions[0]?.totalInputTokens).toBe(60)
    expect(processedFile(third.processedFiles, forkPath).ownedDedupeKeys).toHaveLength(3)
  })

  it.each(['rewritten', 'truncated'])(
    'reclaims an unchanged fork after its owner is %s',
    async (mode) => {
      const ownerPath = join(projectDir, 'aaaa-owner.jsonl')
      const forkPath = join(projectDir, 'zzzz-deferred-fork.jsonl')
      await writeFile(ownerPath, largePrefix() + assistantRow('shared'))
      await writeFile(
        forkPath,
        largePrefix() +
          assistantRow('shared', { sessionId: 'fork-session' }) +
          assistantRow('fork-new', { sessionId: 'fork-session', inputTokens: 20 })
      )
      const scan = await scanner()
      const first = await scan()
      const unrelated = assistantRow('replacement', {
        sessionId: 'replacement-session',
        inputTokens: 11
      })
      await writeFile(
        ownerPath,
        mode === 'rewritten' ? largePrefix('replacement') + unrelated : unrelated
      )

      const second = await scan(first.processedFiles)
      const cold = await scan()
      expect(second.sessions).toEqual(cold.sessions)
      expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
      expect(processedFile(second.processedFiles, forkPath).ownedDedupeKeys).toEqual([
        'message-shared:request-shared',
        'message-fork-new:request-fork-new'
      ])
      expect(second.sessions.reduce((total, session) => total + session.totalInputTokens, 0)).toBe(
        41
      )
    }
  )

  it('keeps first-row metadata while applying independent token maxima across appends', async () => {
    const transcriptPath = join(projectDir, 'first-metadata.jsonl')
    await writeFile(
      transcriptPath,
      largePrefix() + assistantRow('streamed', { outputTokens: 2, cacheWriteTokens: 5 })
    )
    const scan = await scanner()
    const first = await scan()
    const firstOffset = processedFile(first.processedFiles, transcriptPath).size
    const changedMetadata = {
      sessionId: 'different-session',
      timestamp: '2026-10-10T12:00:00.000Z',
      model: 'claude-opus-4-6',
      cwd: worktrees[1]?.path,
      gitBranch: 'different-branch'
    }
    await appendFile(
      transcriptPath,
      assistantRow('streamed', {
        ...changedMetadata,
        inputTokens: 20,
        outputTokens: 7,
        cacheReadTokens: 100,
        cacheWriteTokens: 8,
        cacheWrite1hTokens: 3
      })
    )
    streamReads.length = 0
    const second = await scan(first.processedFiles)
    expect(parseReadOffsets(transcriptPath)).toEqual([firstOffset])

    await appendFile(
      transcriptPath,
      assistantRow('streamed', {
        ...changedMetadata,
        inputTokens: 15,
        outputTokens: 12,
        cacheReadTokens: 50,
        cacheWriteTokens: 6,
        cacheWrite1hTokens: 5
      })
    )
    streamReads.length = 0
    const third = await scan(second.processedFiles)
    expect(parseReadOffsets(transcriptPath)).toEqual([
      processedFile(second.processedFiles, transcriptPath).size
    ])
    const cold = await scan()
    expect(third.sessions).toEqual(cold.sessions)
    expect(third.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(third.sessions).toHaveLength(1)
    expect(third.sessions[0]).toMatchObject({
      sessionId: 'owner-session',
      firstTimestamp: '2026-10-09T12:00:00.000Z',
      lastTimestamp: '2026-10-09T12:00:00.000Z',
      model: 'claude-sonnet-4-6',
      lastCwd: worktrees[0]?.path,
      lastGitBranch: 'original-branch',
      primaryWorktreeId: 'worktree-a',
      turnCount: 1,
      totalInputTokens: 20,
      totalOutputTokens: 12,
      totalCacheReadTokens: 100,
      totalCacheWriteTokens: 8,
      totalCacheWrite1hTokens: 5
    })
    expect(third.dailyAggregates[0]?.zeroCacheReadTurnCount).toBe(0)
  })

  it('keeps two keys aligned with distinct metadata after persisted appends arrive in reversed key order', async () => {
    const transcriptPath = join(projectDir, 'persisted-key-alignment.jsonl')
    const firstMetadata = {
      sessionId: 'session-a',
      timestamp: '2026-10-09T12:00:00.000Z',
      cwd: worktrees[0]?.path,
      model: 'claude-sonnet-4-6',
      gitBranch: 'branch-a'
    }
    const secondMetadata = {
      sessionId: 'session-b',
      timestamp: '2026-10-08T13:00:00.000Z',
      cwd: worktrees[1]?.path,
      model: 'claude-opus-4-6',
      gitBranch: 'branch-b'
    }
    await writeFile(
      transcriptPath,
      largePrefix() +
        assistantRow('key-a', {
          ...firstMetadata,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 20,
          cacheWrite1hTokens: 3
        }) +
        assistantRow('key-b', {
          ...secondMetadata,
          inputTokens: 20,
          outputTokens: 80,
          cacheWriteTokens: 7,
          cacheWrite1hTokens: 2
        })
    )
    const scan = await scanner()
    const first = await scan()
    const firstCache: ClaudeUsagePersistedFile[] = JSON.parse(JSON.stringify(first.processedFiles))
    await appendFile(
      transcriptPath,
      assistantRow('key-b', {
        ...firstMetadata,
        timestamp: '2026-10-10T12:00:00.000Z',
        inputTokens: 50,
        outputTokens: 70,
        cacheReadTokens: 11,
        cacheWriteTokens: 9,
        cacheWrite1hTokens: 1
      }) +
        assistantRow('key-a', {
          ...secondMetadata,
          timestamp: '2026-10-11T12:00:00.000Z',
          inputTokens: 80,
          outputTokens: 30,
          cacheReadTokens: 1,
          cacheWriteTokens: 25,
          cacheWrite1hTokens: 5
        })
    )
    streamReads.length = 0
    const second = await scan(firstCache)
    expect(parseReadOffsets(transcriptPath)).toEqual([
      processedFile(firstCache, transcriptPath).size
    ])
    const secondCold = await scan()
    expect(second.sessions).toEqual(secondCold.sessions)
    expect(second.dailyAggregates).toEqual(secondCold.dailyAggregates)
    const secondCache: ClaudeUsagePersistedFile[] = JSON.parse(
      JSON.stringify(second.processedFiles)
    )
    await appendFile(
      transcriptPath,
      assistantRow('key-b', {
        ...firstMetadata,
        inputTokens: 40,
        outputTokens: 90,
        cacheReadTokens: 9,
        cacheWriteTokens: 8,
        cacheWrite1hTokens: 4
      }) +
        assistantRow('key-a', {
          ...secondMetadata,
          inputTokens: 130,
          outputTokens: 20,
          cacheWriteTokens: 24,
          cacheWrite1hTokens: 4
        })
    )
    streamReads.length = 0
    const third = await scan(secondCache)
    expect(parseReadOffsets(transcriptPath)).toEqual([
      processedFile(secondCache, transcriptPath).size
    ])
    const cold = await scan()
    expect(third.sessions).toEqual(cold.sessions)
    expect(third.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(third.sessions.find((session) => session.sessionId === 'session-a')).toMatchObject({
      firstTimestamp: firstMetadata.timestamp,
      lastTimestamp: firstMetadata.timestamp,
      model: firstMetadata.model,
      lastCwd: firstMetadata.cwd,
      lastGitBranch: firstMetadata.gitBranch,
      primaryWorktreeId: 'worktree-a',
      turnCount: 1,
      totalInputTokens: 130,
      totalOutputTokens: 30,
      totalCacheReadTokens: 5,
      totalCacheWriteTokens: 25,
      totalCacheWrite1hTokens: 5
    })
    expect(third.sessions.find((session) => session.sessionId === 'session-b')).toMatchObject({
      firstTimestamp: secondMetadata.timestamp,
      lastTimestamp: secondMetadata.timestamp,
      model: secondMetadata.model,
      lastCwd: secondMetadata.cwd,
      lastGitBranch: secondMetadata.gitBranch,
      primaryWorktreeId: 'worktree-b',
      turnCount: 1,
      totalInputTokens: 50,
      totalOutputTokens: 90,
      totalCacheReadTokens: 11,
      totalCacheWriteTokens: 9,
      totalCacheWrite1hTokens: 4
    })
  })

  it('keeps an invalid first timestamp uncounted when a later duplicate has valid metadata', async () => {
    const transcriptPath = join(projectDir, 'invalid-first-timestamp.jsonl')
    await writeFile(
      transcriptPath,
      largePrefix() + assistantRow('invalid-first', { timestamp: 'invalid-timestamp' })
    )
    const scan = await scanner()
    const first = await scan()
    expect(first.sessions).toEqual([])
    expect(processedFile(first.processedFiles, transcriptPath).ownedDedupeKeys).toEqual([
      'message-invalid-first:request-invalid-first'
    ])
    await appendFile(
      transcriptPath,
      assistantRow('invalid-first', { sessionId: 'valid-later-session', inputTokens: 20 })
    )
    streamReads.length = 0
    const second = await scan(first.processedFiles)
    expect(parseReadOffsets(transcriptPath)).toEqual([
      processedFile(first.processedFiles, transcriptPath).size
    ])
    const cold = await scan()
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(second.sessions).toEqual([])
    expect(second.dailyAggregates).toEqual([])
  })

  it('uses first session encounter order when an append creates a last-timestamp tie', async () => {
    const transcriptPath = join(projectDir, 'session-tie.jsonl')
    await writeFile(
      transcriptPath,
      largePrefix() +
        assistantRow('session-a-first', { sessionId: 'session-a' }) +
        assistantRow('session-b-first', {
          sessionId: 'session-b',
          timestamp: '2026-10-09T13:00:00.000Z'
        })
    )
    const scan = await scanner()
    const first = await scan()
    expect(first.sessions.map((session) => session.sessionId)).toEqual(['session-b', 'session-a'])

    await appendFile(
      transcriptPath,
      assistantRow('session-a-later', {
        sessionId: 'session-a',
        timestamp: '2026-10-09T13:00:00.000Z'
      })
    )
    streamReads.length = 0
    const second = await scan(first.processedFiles)
    expect(parseReadOffsets(transcriptPath)).toEqual([
      processedFile(first.processedFiles, transcriptPath).size
    ])
    const cold = await scan()
    expect(second.sessions).toEqual(cold.sessions)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
    expect(second.sessions.map((session) => session.sessionId)).toEqual(['session-a', 'session-b'])
  })

  it.each(['keyed', 'unkeyed'])(
    'uses a %s first location encounter when appended maxima create a primary-location tie',
    async (firstRowKind) => {
      const transcriptPath = join(projectDir, 'location-tie.jsonl')
      const secondLocation = assistantRow('second-location', {
        cwd: worktrees[1]?.path,
        inputTokens: 20
      })
      const history =
        firstRowKind === 'unkeyed'
          ? assistantRow('unkeyed-location', { inputTokens: 5, identified: false }) +
            secondLocation +
            assistantRow('first-location', { inputTokens: 5 })
          : assistantRow('first-location', { inputTokens: 10 }) + secondLocation
      await writeFile(transcriptPath, largePrefix() + history)
      const scan = await scanner()
      const first = await scan()
      expect(first.sessions[0]?.primaryWorktreeId).toBe('worktree-b')
      expect(first.sessions[0]?.locationBreakdown.map((location) => location.worktreeId)).toEqual([
        'worktree-b',
        'worktree-a'
      ])
      await appendFile(
        transcriptPath,
        assistantRow('first-location', { inputTokens: firstRowKind === 'unkeyed' ? 15 : 20 })
      )
      streamReads.length = 0
      const second = await scan(first.processedFiles)
      expect(parseReadOffsets(transcriptPath)).toEqual([
        processedFile(first.processedFiles, transcriptPath).size
      ])
      const cold = await scan()
      expect(second.sessions).toEqual(cold.sessions)
      expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
      expect(second.sessions[0]?.primaryWorktreeId).toBe('worktree-a')
      expect(second.sessions[0]?.turnCount).toBe(firstRowKind === 'unkeyed' ? 3 : 2)
      expect(second.sessions[0]?.locationBreakdown.map((location) => location.worktreeId)).toEqual([
        'worktree-a',
        'worktree-b'
      ])
    }
  )
})
