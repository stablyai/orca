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
import {
  _internals as healInternals,
  healCodexAccountSessionIndex
} from '../index/codex-account-session-index-heal'
import SyncDatabase from '../../../sqlite/sync-database'

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
const THREAD_A = '019a0000-0000-7000-8000-00000000000a'
const THREAD_B = '019a0000-0000-7000-8000-00000000000b'
const ROLLOUT_A = join(
  '2026',
  '07',
  '20',
  'rollout-2026-07-20T10-00-00-019a0000-0000-7000-8000-00000000000a.jsonl'
)
const OWN_ROLLOUT = join(
  '2026',
  '07',
  '19',
  'rollout-2026-07-19T10-00-00-019a0000-0000-7000-8000-0000000000ff.jsonl'
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
  healInternals.resetFailedThreads()
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

  it('discovers history added to old date folders and a recreated target on warm passes', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    const bridge = () =>
      bridgeCodexSessionsIntoAccountHome({
        targetCodexHomePath: targetHome,
        sourceCodexHomePaths: [systemHome]
      })
    await bridge()

    // An unarchived or imported rollout lands in an old date folder.
    writeRollout(systemHome, ROLLOUT_B, 'session\n')
    const warm = await bridge()
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_B))).toBe(true)
    expect([...warm.bridgedThreads.keys()].sort()).toEqual([THREAD_A, THREAD_B])

    rmSync(join(targetHome, 'sessions'), { recursive: true, force: true })
    await bridge()
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(true)
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_B))).toBe(true)
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

  it('re-checks readiness each launch once a newer Codex starts indexing the home', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    // An older CLI left history but no state DB, so linking is safe.
    writeRollout(targetHome, OWN_ROLLOUT, 'own\n')
    await startBridge(targetHome, [systemHome])
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(true)

    writeCodexStateDbBackfillStatus(targetHome, 'running')
    writeRollout(systemHome, ROLLOUT_B, 'session\n')
    await startBridge(targetHome, [systemHome])
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_B))).toBe(false)

    // A replaced DB that finished its backfill lets the next launch link again.
    rmSync(join(targetHome, 'state_5.sqlite'))
    writeCodexStateDbBackfillStatus(targetHome, 'complete')
    await startBridge(targetHome, [systemHome])
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_B))).toBe(true)
  })

  it('resumes indexing linked history on a later launch after a heal aborts', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeCodexStateDbBackfillStatus(targetHome, 'complete')
    const db = new SyncDatabase(join(targetHome, 'state_5.sqlite'))
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)')
    db.close()
    let transportUp = false
    const readThreads: string[] = []
    const healIndex: BridgeDependencies['healIndex'] = (home, threads, options) =>
      healCodexAccountSessionIndex(home, threads, {
        ...options,
        interBatchDelayMs: 0,
        buildInvocation: (_home, timeoutMs) => ({
          command: 'codex',
          args: [],
          cliPath: null,
          timeoutMs
        }),
        runSession: async (_invocation, body) => {
          if (!transportUp) {
            throw new Error('app-server connection closed')
          }
          await body({
            request: async (_method, params) => {
              const threadId = String(params?.threadId)
              readThreads.push(threadId)
              const indexDb = new SyncDatabase(join(targetHome, 'state_5.sqlite'))
              indexDb.prepare('INSERT INTO threads (id) VALUES (?)').run(threadId)
              indexDb.close()
              return {}
            },
            notify: () => {}
          })
        }
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await startBridge(targetHome, [systemHome], { healIndex })
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(true)
    expect(readThreads).toEqual([])

    transportUp = true
    await startBridge(targetHome, [systemHome], { healIndex })
    expect(readThreads).toEqual([THREAD_A])

    // Indexed history is not read again.
    await startBridge(targetHome, [systemHome], { healIndex })
    expect(readThreads).toEqual([THREAD_A])
    warn.mockRestore()
  })
})
