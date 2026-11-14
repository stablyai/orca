import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'

import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { scanCodexUsageFiles } from './scanner'

/** Mirrors the checkpoint window in jsonl-file-checkpoint.ts. */

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

/** The iterator marks parse reads to distinguish them from bounded digest reads. */

function recordedResumeOffset(
  files: { path: string; parseResumeState?: { parsedBytes: number } | null }[],
  filePath: string
): number {
  return files.find((file) => file.path === filePath)?.parseResumeState?.parsedBytes ?? 0
}

/** Session attribution catches context corruption that token totals alone can miss. */

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

  // Token totals can match despite a stale session context; compare attribution with a cold scan.

  /** Preserve the boundary window while changing leading records at the same file length. */
})
