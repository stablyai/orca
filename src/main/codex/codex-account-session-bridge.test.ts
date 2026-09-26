import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  bridgeCodexSessionsIntoAccountHome,
  startCodexAccountSessionBridgeInBackground
} from './codex-account-session-bridge'
import { writeCodexStateDbBackfillStatus } from './codex-state-db-test-fixture'
import SyncDatabase from '../sqlite/sync-database'

let workspaceRoot: string
const healIndexStub = vi.fn(async () => ({
  outcome: 'up-to-date' as const,
  healedThreads: 0,
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
  // Why: the real steps spawn `codex app-server`; their behavior is covered separately.
  _internals.setBackgroundBridgeDependencies({
    createStateDb: async () => false,
    healIndex: healIndexStub
  })
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('bridgeCodexSessionsIntoAccountHome', () => {
  it('links every source home rollout into the target account home', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const otherAccountHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    writeRollout(systemHome, ROLLOUT_A, 'system session\n')
    writeRollout(otherAccountHome, ROLLOUT_B, 'account a session\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome, otherAccountHome],
      options: { batchSize: 1, yieldMs: 0 }
    })

    expect(summary).toEqual({
      scannedFiles: 2,
      linkedFiles: 2,
      bridgedThreadIds: new Set([THREAD_A, THREAD_B])
    })
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_A), 'utf-8')).toBe('system session\n')
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_B), 'utf-8')).toBe('account a session\n')
  })

  it('shares one physical log so an appended resume is visible from both homes', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    const sourcePath = writeRollout(systemHome, ROLLOUT_A, 'first\n')

    await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    const targetPath = rolloutPath(targetHome, ROLLOUT_A)
    // Why: hardlinks are the whole point — a resume that appends under one home
    // must not fork the conversation into two diverging logs.
    expect(statSync(targetPath).ino).toBe(statSync(sourcePath).ino)
  })

  it('bridges compressed rollouts so archived history still resumes', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    const compressed = join('2026', '07', '19', 'rollout-2026-07-19T10-00-00-cccc.jsonl.zst')
    writeRollout(systemHome, compressed, 'compressed\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(summary.linkedFiles).toBe(1)
    expect(readFileSync(rolloutPath(targetHome, compressed), 'utf-8')).toBe('compressed\n')
  })

  it('leaves an already-bridged rollout untouched on a later launch', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'first\n')
    await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    const second = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(second).toEqual({
      scannedFiles: 1,
      linkedFiles: 0,
      bridgedThreadIds: new Set([THREAD_A])
    })
  })

  it('never links a home into itself or scans a duplicate source twice', async () => {
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(targetHome, ROLLOUT_A, 'own session\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [targetHome, targetHome]
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0, bridgedThreadIds: new Set() })
  })

  it('skips a source home that has no sessions tree', async () => {
    const targetHome = join(workspaceRoot, 'account')
    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [join(workspaceRoot, 'missing')]
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0, bridgedThreadIds: new Set() })
  })
})

describe('startCodexAccountSessionBridgeInBackground', () => {
  it('shares one in-flight task per target home', () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeCodexStateDbBackfillStatus(targetHome, 'complete')

    const first = startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })
    const second = startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(second).toBe(first)
    return first
  })

  it('runs separate targets independently', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const firstTarget = join(workspaceRoot, 'account-a')
    const secondTarget = join(workspaceRoot, 'account-b')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeCodexStateDbBackfillStatus(firstTarget, 'complete')
    writeCodexStateDbBackfillStatus(secondTarget, 'complete')

    await Promise.all([
      startCodexAccountSessionBridgeInBackground({
        targetCodexHomePath: firstTarget,
        sourceCodexHomePaths: [systemHome]
      }),
      startCodexAccountSessionBridgeInBackground({
        targetCodexHomePath: secondTarget,
        sourceCodexHomePaths: [systemHome]
      })
    ])

    expect(readFileSync(rolloutPath(firstTarget, ROLLOUT_A), 'utf-8')).toBe('session\n')
    expect(readFileSync(rolloutPath(secondTarget, ROLLOUT_A), 'utf-8')).toBe('session\n')
  })

  // #20669: rollouts present when Codex first creates its state DB force a
  // blocking backfill that times out the first TUI launch.
  it('lets Codex index a new home before linking history into it', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    const createStateDb = vi.fn(async (home: string) => {
      expect(existsSync(rolloutPath(home, ROLLOUT_A))).toBe(false)
      writeCodexStateDbBackfillStatus(home, 'complete')
      return true
    })
    _internals.setBackgroundBridgeDependencies({ createStateDb, healIndex: healIndexStub })

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(createStateDb).toHaveBeenCalledWith(targetHome)
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_A), 'utf-8')).toBe('session\n')
  })

  it('links history when this Codex keeps no state DB', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    _internals.setBackgroundBridgeDependencies({
      createStateDb: async () => true,
      healIndex: healIndexStub
    })

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_A), 'utf-8')).toBe('session\n')
  })

  it('does not link history when Codex could not create the state DB', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    _internals.setBackgroundBridgeDependencies({
      createStateDb: async () => false,
      healIndex: healIndexStub
    })

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
    expect(healIndexStub).not.toHaveBeenCalled()
  })

  it('leaves an unindexed home that holds its own history to Codex', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeRollout(targetHome, ROLLOUT_B, 'own session\n')
    const createStateDb = vi.fn(async () => true)
    _internals.setBackgroundBridgeDependencies({ createStateDb, healIndex: healIndexStub })

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(createStateDb).not.toHaveBeenCalled()
    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
  })

  it('bridges compressed-only history into a new home and indexes it', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    const compressed = `${ROLLOUT_A}.zst`
    writeRollout(systemHome, compressed, 'compressed\n')
    const createStateDb = vi.fn(async (home: string) => {
      writeCodexStateDbBackfillStatus(home, 'complete')
      return true
    })
    _internals.setBackgroundBridgeDependencies({ createStateDb, healIndex: healIndexStub })

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(readFileSync(rolloutPath(targetHome, compressed), 'utf-8')).toBe('compressed\n')
    expect(healIndexStub).toHaveBeenCalledWith(targetHome, new Set([THREAD_A]))
  })

  it('skips linking into a state DB that predates backfill tracking', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    mkdirSync(targetHome, { recursive: true })
    new SyncDatabase(join(targetHome, 'state_5.sqlite')).close()

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
  })

  it('skips linking while Codex is still indexing the home', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeCodexStateDbBackfillStatus(targetHome, 'running')

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

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

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(existsSync(rolloutPath(targetHome, ROLLOUT_A))).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Codex state DB is unreadable'),
      expect.any(String)
    )
    warn.mockRestore()
  })

  it('indexes the bridged threads once linking finishes', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')
    writeCodexStateDbBackfillStatus(targetHome, 'complete')

    await startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(healIndexStub).toHaveBeenCalledWith(targetHome, new Set([THREAD_A]))
  })
})
