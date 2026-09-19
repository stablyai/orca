import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as WorktreeLogic from '../ipc/worktree-logic'

const { getPathMock, homedirMock, worktreePathComparisons } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  worktreePathComparisons: { count: 0 }
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

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeLogic>()
  return {
    ...actual,
    areWorktreePathsEqual: (left: string, right: string) => {
      worktreePathComparisons.count += 1
      return actual.areWorktreePathsEqual(left, right)
    }
  }
})

import { scanCodexUsageFiles } from './scanner'

const WORKTREE_COUNT = 4
const EVENTS_PER_FILE = 4

let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined
const originalCodexHome = process.env.CODEX_HOME

function usageRecord(timestamp: string, totalInputTokens: number): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        last_token_usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 1
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

function writeSessionFile(
  sessionsDir: string,
  sessionId: string,
  cwd: string,
  tokenOffset: number
): void {
  // Why: event keys are content-derived, so identical records across files would be
  // deduped by cross-file ownership and the scan would see one session, not three.
  const records = [
    `${JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } })}\n`,
    ...Array.from({ length: EVENTS_PER_FILE }, (_, index) =>
      usageRecord(
        `2026-07-21T12:${String(index).padStart(2, '0')}:00.000Z`,
        tokenOffset + index + 1
      )
    )
  ]
  writeFileSync(join(sessionsDir, `${sessionId}.jsonl`), records.join(''), 'utf-8')
}

beforeEach(() => {
  delete process.env.CODEX_HOME
  worktreePathComparisons.count = 0
  // Why: worktree canonicalization realpaths, so /var vs /private/var would never match.
  fakeHomeDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-memo-home-')))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-memo-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
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

it('resolves each distinct cwd once per scan, not once per event', async () => {
  const sessionsDir = join(fakeHomeDir, '.codex', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const matchedCwd = join(fakeHomeDir, 'worktrees', 'repo-003', 'packages', 'app')
  const unmatchedCwd = join(fakeHomeDir, 'elsewhere', 'project')
  // Two files share a cwd so the memo must survive across files, not just within one.
  writeSessionFile(sessionsDir, 'session-a', matchedCwd, 0)
  writeSessionFile(sessionsDir, 'session-b', matchedCwd, 1_000)
  writeSessionFile(sessionsDir, 'session-c', unmatchedCwd, 2_000)
  const worktrees = Array.from({ length: WORKTREE_COUNT }, (_, index) => {
    const worktreePath = join(fakeHomeDir, 'worktrees', `repo-${String(index).padStart(3, '0')}`)
    mkdirSync(worktreePath, { recursive: true })
    return {
      repoId: `repo-${index}`,
      worktreeId: `repo-${index}::${worktreePath}`,
      path: worktreePath,
      displayName: `Repo ${index}`
    }
  })

  const result = await scanCodexUsageFiles(worktrees, [])

  expect(result.sessions).toHaveLength(3)
  const attributedWorktreeIds = new Set(
    result.sessions.flatMap((session) =>
      session.locationBreakdown.map((location) => location.worktreeId)
    )
  )
  expect(attributedWorktreeIds).toEqual(
    new Set([`repo-3::${join(fakeHomeDir, 'worktrees', 'repo-003')}`, null])
  )
  // Two distinct cwds against every worktree; an unmemoized scan would pay this per event.
  expect(worktreePathComparisons.count).toBeLessThanOrEqual(2 * WORKTREE_COUNT)
  expect(worktreePathComparisons.count).toBeLessThan(EVENTS_PER_FILE * WORKTREE_COUNT)
})
