import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tmpdir()) } }))

import { parseMuseUsageLine, type MuseUsageParseContext } from './muse-usage-record-parser'
import { scanMuseUsageFiles } from './scanner'

// Shapes mirror real Muse 1.3 session.jsonl records; ids and paths are placeholders.
const MICROS = 1_790_052_419_142_353

function envelope(
  payloadType: string,
  payload: Record<string, unknown>,
  recordedAt = MICROS
): Record<string, unknown> {
  return {
    schema_version: 1,
    id: `record-${recordedAt}`,
    stream: { kind: 'session', id: 'session-placeholder' },
    sequence: 1,
    recorded_at: recordedAt,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload
  }
}

function metadata(workspaceRoot: string): Record<string, unknown> {
  return envelope('runtime.session.metadata', {
    kind: 'metadata',
    record: { workspace_root: workspaceRoot, provider_id: 'meta', build: 'x' }
  })
}

function modelConfigured(modelId: string): Record<string, unknown> {
  return envelope('run.model.configured', {
    kind: 'run_model',
    record: { provider_id: 'meta', model_id: modelId, source: 'startup' }
  })
}

function modelCompleted(
  recordedAt: number,
  usage: Record<string, number>,
  model?: string
): Record<string, unknown> {
  return envelope(
    'runtime.session',
    {
      kind: 'run',
      run_id: 'run-placeholder',
      event: {
        kind: 'model_completed',
        usage: {
          cached_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          reasoning_tokens: 0,
          ...usage
        },
        duration_ms: 2636,
        ...(model ? { model } : {})
      }
    },
    recordedAt
  )
}

function retainedFrame(children: Record<string, unknown>[]): Record<string, unknown> {
  return {
    retained_frame: true,
    children: children.map((child) => ({ record_json: JSON.stringify(child) }))
  }
}

function toJsonl(records: Record<string, unknown>[]): string {
  return `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`
}

describe('parseMuseUsageLine', () => {
  it('reads model_completed usage and falls back to the configured model', () => {
    const context: MuseUsageParseContext = { sessionId: 's1', cwd: null, currentModel: null }
    expect(parseMuseUsageLine(JSON.stringify(metadata('/workspace/repo')), context)).toEqual([])
    expect(parseMuseUsageLine(JSON.stringify(modelConfigured('muse-spark-1.3')), context)).toEqual(
      []
    )
    const [event] = parseMuseUsageLine(
      JSON.stringify(
        modelCompleted(MICROS, {
          input_tokens: 28_000,
          output_tokens: 289,
          cached_tokens: 27_889,
          cache_read_tokens: 27_889,
          reasoning_tokens: 162
        })
      ),
      context
    )
    expect(event).toMatchObject({
      sessionId: 's1',
      timestamp: new Date(Math.floor(MICROS / 1000)).toISOString(),
      model: 'muse-spark-1.3',
      cwd: '/workspace/repo',
      inputTokens: 28_000,
      cachedInputTokens: 27_889,
      outputTokens: 289,
      reasoningOutputTokens: 162,
      totalTokens: 28_289
    })
  })

  it('unwraps retained_frame batches and prefers the event model', () => {
    const context: MuseUsageParseContext = { sessionId: 's1', cwd: null, currentModel: 'default' }
    const events = parseMuseUsageLine(
      JSON.stringify(
        retainedFrame([
          modelCompleted(MICROS, { input_tokens: 10, output_tokens: 5 }, 'muse-spark-1.3'),
          modelCompleted(MICROS + 1, { input_tokens: 20, output_tokens: 5 })
        ])
      ),
      context
    )
    expect(events.map((event) => [event.model, event.totalTokens])).toEqual([
      ['muse-spark-1.3', 15],
      ['default', 25]
    ])
  })

  it('ignores other runtime events and malformed lines', () => {
    const context: MuseUsageParseContext = { sessionId: 's1', cwd: null, currentModel: null }
    const started = envelope('runtime.session', {
      kind: 'run',
      event: { kind: 'started', prompt: 'model_completed is only text here' }
    })
    expect(parseMuseUsageLine(JSON.stringify(started), context)).toEqual([])
    expect(
      parseMuseUsageLine('{"payload_type":"runtime.session","model_completed', context)
    ).toEqual([])
  })
})

describe('scanMuseUsageFiles', () => {
  let root: string
  let sessionsDir: string
  let worktreePath: string

  beforeEach(async () => {
    root = await realpath(mkdtempSync(join(tmpdir(), 'muse-usage-')))
    sessionsDir = join(root, 'sessions')
    worktreePath = join(root, 'repo')
    mkdirSync(worktreePath, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeSession(
    day: string,
    sessionId: string,
    records: Record<string, unknown>[]
  ): string {
    const dir = join(sessionsDir, ...day.split('-'), sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, toJsonl(records))
    return file
  }

  const worktrees = (): {
    repoId: string
    worktreeId: string
    path: string
    displayName: string
  }[] => [{ repoId: 'repo-1', worktreeId: 'wt-1', path: worktreePath, displayName: 'repo/main' }]

  it('aggregates sessions and attributes them to the Orca worktree', async () => {
    writeSession('2026-09-22', 'session-a', [
      metadata(worktreePath),
      modelConfigured('muse-spark-1.3'),
      modelCompleted(MICROS, { input_tokens: 1000, output_tokens: 100, cached_tokens: 400 }),
      retainedFrame([modelCompleted(MICROS + 5_000_000, { input_tokens: 500, output_tokens: 50 })])
    ])
    writeSession('2026-09-22', 'session-b', [
      metadata('/elsewhere/project'),
      modelCompleted(MICROS, { input_tokens: 7, output_tokens: 3 }, 'muse-spark-1.3-contributor')
    ])
    // A shard dir that never received a log (`--no-session-log`).
    mkdirSync(join(sessionsDir, '2026', '09', '22', 'session-empty'), { recursive: true })
    mkdirSync(join(sessionsDir, '.msp-view-v1', 'ignored'), { recursive: true })

    const result = await scanMuseUsageFiles(worktrees(), [], undefined, sessionsDir)

    expect(result.processedFiles).toHaveLength(2)
    const byId = new Map(result.sessions.map((session) => [session.sessionId, session]))
    expect(byId.get('session-a')).toMatchObject({
      eventCount: 2,
      totalInputTokens: 1500,
      totalCachedInputTokens: 400,
      totalOutputTokens: 150,
      totalTokens: 1650,
      primaryModel: 'muse-spark-1.3',
      primaryWorktreeId: 'wt-1',
      primaryProjectLabel: 'repo/main'
    })
    expect(byId.get('session-b')).toMatchObject({
      totalTokens: 10,
      primaryWorktreeId: null,
      primaryModel: 'muse-spark-1.3-contributor'
    })
    expect(result.dailyAggregates.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(1660)
  })

  it('reuses unchanged files and reparses only grown ones', async () => {
    const stable = writeSession('2026-09-21', 'stable', [
      metadata(worktreePath),
      modelCompleted(MICROS, { input_tokens: 100, output_tokens: 10 }, 'm')
    ])
    const live = writeSession('2026-09-22', 'live', [
      metadata(worktreePath),
      modelCompleted(MICROS + 1, { input_tokens: 200, output_tokens: 20 }, 'm')
    ])
    const first = await scanMuseUsageFiles(worktrees(), [], undefined, sessionsDir)

    // Same-size rewrite with the cache pinned to the new stat: a reused entry keeps the
    // old totals, proving the unchanged-stat file was not reread.
    const altered = toJsonl([
      metadata(worktreePath),
      modelCompleted(MICROS, { input_tokens: 900, output_tokens: 90 }, 'm')
    ])
    expect(Buffer.byteLength(altered)).toBe(statSync(stable).size)
    writeFileSync(stable, altered)
    const previous = first.processedFiles.map((file) =>
      file.path === stable ? { ...file, mtimeMs: statSync(stable).mtimeMs } : file
    )

    await appendFile(
      live,
      toJsonl([modelCompleted(MICROS + 2, { input_tokens: 300, output_tokens: 30 }, 'm')])
    )
    const onFilesScanned = vi.fn()
    const second = await scanMuseUsageFiles(worktrees(), previous, onFilesScanned, sessionsDir)

    expect(onFilesScanned).toHaveBeenCalledTimes(1)
    const byId = new Map(second.sessions.map((session) => [session.sessionId, session]))
    expect(byId.get('stable')?.totalTokens).toBe(110)
    expect(byId.get('live')).toMatchObject({ eventCount: 2, totalTokens: 550 })
  })

  it('counts a usage record copied into another session log once', async () => {
    const shared = modelCompleted(MICROS, { input_tokens: 100, output_tokens: 10 }, 'm')
    writeSession('2026-09-22', 'a-parent', [metadata(worktreePath), shared])
    const fork = writeSession('2026-09-22', 'b-fork', [
      metadata(worktreePath),
      shared,
      modelCompleted(MICROS + 9, { input_tokens: 5, output_tokens: 5 }, 'm')
    ])

    const first = await scanMuseUsageFiles(worktrees(), [], undefined, sessionsDir)
    expect(first.sessions.reduce((sum, session) => sum + session.totalTokens, 0)).toBe(120)
    expect(first.processedFiles.find((file) => file.path === fork)?.hasDeferredClaims).toBe(true)

    // Deleting the owner lets the deferring file reclaim the shared record.
    rmSync(join(sessionsDir, '2026', '09', '22', 'a-parent'), { recursive: true })
    const second = await scanMuseUsageFiles(
      worktrees(),
      first.processedFiles,
      undefined,
      sessionsDir
    )
    expect(second.sessions).toHaveLength(1)
    expect(second.sessions[0]).toMatchObject({ sessionId: 'b-fork', totalTokens: 120 })
  })

  it('keeps distinct same-content records in one log and dedupes their copies elsewhere', async () => {
    const turn = (): Record<string, unknown> =>
      modelCompleted(MICROS, { input_tokens: 100, output_tokens: 10 }, 'm')
    const owner = writeSession('2026-09-22', 'a-parent', [
      metadata(worktreePath),
      retainedFrame([turn(), turn()])
    ])
    writeSession('2026-09-22', 'b-fork', [metadata(worktreePath), turn(), turn()])

    const first = await scanMuseUsageFiles(worktrees(), [], undefined, sessionsDir)
    const byId = new Map(first.sessions.map((session) => [session.sessionId, session]))
    expect(byId.get('a-parent')).toMatchObject({ eventCount: 2, totalTokens: 220 })
    expect(byId.has('b-fork')).toBe(false)

    // Unchanged rescan reuses retained claims; an append reparses without recounting.
    const second = await scanMuseUsageFiles(
      worktrees(),
      first.processedFiles,
      undefined,
      sessionsDir
    )
    expect(second.sessions.reduce((sum, session) => sum + session.totalTokens, 0)).toBe(220)
    await appendFile(owner, toJsonl([turn()]))
    const third = await scanMuseUsageFiles(
      worktrees(),
      second.processedFiles,
      undefined,
      sessionsDir
    )
    expect(third.sessions.reduce((sum, session) => sum + session.totalTokens, 0)).toBe(330)
  })

  it('rolls subagent logs into the parent session and workspace', async () => {
    writeSession('2026-09-22', 'parent', [
      metadata(worktreePath),
      modelCompleted(MICROS, { input_tokens: 100, output_tokens: 10 }, 'm')
    ])
    // Real subagent logs carry model metadata but no workspace_root.
    const childMetadata = envelope('runtime.session.metadata', {
      kind: 'metadata',
      record: { provider_id: 'meta', model_id: 'muse-spark-1.3' }
    })
    writeSession('2026-09-22', join('parent', 'subagent', 'child'), [
      childMetadata,
      modelCompleted(MICROS + 7, { input_tokens: 40, output_tokens: 4 })
    ])

    const result = await scanMuseUsageFiles(worktrees(), [], undefined, sessionsDir)

    expect(result.processedFiles).toHaveLength(2)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'parent',
      eventCount: 2,
      totalTokens: 154,
      primaryWorktreeId: 'wt-1',
      hasMixedModels: true
    })
  })

  it('returns nothing when the sessions directory is missing', async () => {
    const result = await scanMuseUsageFiles(worktrees(), [], undefined, join(root, 'missing'))
    expect(result).toEqual({ processedFiles: [], sessions: [], dailyAggregates: [] })
  })

  it('reports a sessions root that exists but cannot be listed', async () => {
    const notADirectory = join(root, 'sessions-file')
    writeFileSync(notADirectory, '')
    await expect(
      scanMuseUsageFiles(worktrees(), [], undefined, notADirectory)
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
