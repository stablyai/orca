import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  bridgeCodexSessionsIntoAccountHome,
  startCodexAccountSessionBridgeInBackground,
  stopCodexAccountSessionBridges
} from './codex-account-session-bridge'
import { writeCodexStateDbBackfillStatus } from '../index/codex-state-db-test-fixture'

let workspaceRoot: string
const healIndexStub = vi.fn(async () => ({
  outcome: 'up-to-date' as const,
  healedThreads: 0,
  missingThreads: 0,
  failedThreads: 0
}))

function writeRollout(homePath: string, relativePath: string, contents: string): string {
  const filePath = join(homePath, 'sessions', relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, contents)
  return filePath
}

function rolloutPath(homePath: string, relativePath: string): string {
  return join(homePath, 'sessions', relativePath)
}
const THREAD_B = '019a0000-0000-7000-8000-00000000000b'
const ROLLOUT_A = join(
  '2026',
  '07',
  '20',
  'rollout-2026-07-20T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl'
)
const ROLLOUT_B = join(
  '2026',
  '07',
  '21',
  'rollout-2026-07-21T10-00-00-019a0000-0000-7000-8000-00000000000b.jsonl'
)

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codex-account-session-bridge-'))
  _internals.resetBackgroundBridgeTasks()
  healIndexStub.mockClear()
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('bridgeCodexSessionsIntoAccountHome', () => {
  it('does not hand a rollout it failed to link to the index heal', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeRollout(systemHome, ROLLOUT_B, 'session\n')
    // A file where the target's day directory belongs makes that one link fail.
    mkdirSync(join(targetHome, 'sessions', '2026', '07'), { recursive: true })
    writeFileSync(join(targetHome, 'sessions', '2026', '07', '20'), 'not a directory')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    warn.mockRestore()
    expect(summary.linkedFiles).toBe(1)
    expect(summary.bridgedThreads).toEqual(new Map([[THREAD_B, '2026-07-21T10-00-00']]))
  })
})

type BridgeDependencies = NonNullable<
  Parameters<typeof startCodexAccountSessionBridgeInBackground>[1]
>

// Why: the real steps spawn `codex app-server`; their behavior is covered separately.
function startBridge(
  targetCodexHomePath: string,
  sourceCodexHomePaths: string[],
  dependencies: BridgeDependencies = {}
): Promise<void> {
  return startCodexAccountSessionBridgeInBackground(
    { targetCodexHomePath, sourceCodexHomePaths },
    { createStateDb: async () => false, healIndex: healIndexStub, ...dependencies }
  )
}

describe('startCodexAccountSessionBridgeInBackground', () => {
  // Older CLIs and sqlite_home can leave the home without a DB across launches.

  it('skips linking while Codex is still indexing the home', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeCodexStateDbBackfillStatus(targetHome, 'running')

    await startBridge(targetHome, [systemHome])

    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
    expect(healIndexStub).not.toHaveBeenCalled()
  })

  it('reports why it skips a home whose state DB cannot be read', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    mkdirSync(targetHome, { recursive: true })
    writeFileSync(join(targetHome, 'state_5.sqlite'), 'not a sqlite database')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await startBridge(targetHome, [systemHome])

    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Codex state DB is unreadable'),
      expect.any(String)
    )
    warn.mockRestore()
  })

  it('links nothing when the app quits while Codex creates the state DB', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')

    await startBridge(targetHome, [systemHome], {
      createStateDb: async (home) => {
        writeCodexStateDbBackfillStatus(home, 'complete')
        stopCodexAccountSessionBridges()
        return true
      }
    })

    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
    expect(healIndexStub).not.toHaveBeenCalled()
  })
})
