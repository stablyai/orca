import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _internals,
  bridgeCodexSessionsIntoAccountHome,
  startCodexAccountSessionBridgeInBackground
} from './codex-account-session-bridge'

let workspaceRoot: string

function writeRollout(homePath: string, relativePath: string, contents: string): string {
  const filePath = join(homePath, 'sessions', relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, contents)
  return filePath
}

function rolloutPath(homePath: string, relativePath: string): string {
  return join(homePath, 'sessions', relativePath)
}

const ROLLOUT_A = join('2026', '07', '20', 'rollout-2026-07-20T10-00-00-aaaa.jsonl')
const ROLLOUT_B = join('2026', '07', '21', 'rollout-2026-07-21T10-00-00-bbbb.jsonl')

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codex-account-session-bridge-'))
  _internals.resetBackgroundBridgeTasks()
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

    expect(summary).toEqual({ scannedFiles: 2, linkedFiles: 2 })
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

    expect(second).toEqual({ scannedFiles: 1, linkedFiles: 0 })
  })

  it('never links a home into itself or scans a duplicate source twice', async () => {
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(targetHome, ROLLOUT_A, 'own session\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [targetHome, targetHome]
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0 })
  })

  it('skips a source home that has no sessions tree', async () => {
    const targetHome = join(workspaceRoot, 'account')
    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [join(workspaceRoot, 'missing')]
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0 })
  })
})

describe('startCodexAccountSessionBridgeInBackground', () => {
  it('shares one in-flight task per target home', () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')

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
})
