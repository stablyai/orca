import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => tmpdir()) } }))

import { parseMuseUsageLine, type MuseUsageParseContext } from './muse-usage-record-parser'
import { scanMuseUsageFiles } from './scanner'

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
})
