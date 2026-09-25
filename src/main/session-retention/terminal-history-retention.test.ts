import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PENDING_DELETE_DIR_NAME } from '../terminal-history-paths'
import {
  applyTerminalHistoryRetention,
  TERMINAL_HISTORY_PENDING_DELETE_DIR_NAME
} from './terminal-history-retention'

const NOW = Date.parse('2026-09-21T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const LIVE = 'repo-1::/path/live'
const GONE = 'repo-1::/path/gone'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function historyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-terminal-history-retention-'))
  roots.push(root)
  return root
}

function seed(root: string, name: string, worktreeId: string | null, ageMs: number | null): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'zsh_history'), 'ls\n')
  if (worktreeId) {
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        worktreeId,
        ...(ageMs === null ? {} : { createdAt: new Date(NOW - ageMs).toISOString() })
      })
    )
  }
  return dir
}

describe('applyTerminalHistoryRetention', () => {
  it('uses the same pending-delete directory name as history deletion', () => {
    expect(TERMINAL_HISTORY_PENDING_DELETE_DIR_NAME).toBe(PENDING_DELETE_DIR_NAME)
  })

  it('removes old history for a gone worktree and keeps a live worktree and a recent orphan', async () => {
    const root = historyRoot()
    const live = seed(root, 'live-old', LIVE, 40 * DAY)
    const oldGone = seed(root, 'gone-old', GONE, 40 * DAY)
    const recentGone = seed(root, 'gone-recent', 'repo-1::/path/recent-gone', 2 * DAY)
    const unknown = seed(root, 'no-meta', null, null)

    const result = await applyTerminalHistoryRetention({
      historyRoot: root,
      liveWorktreeIds: new Set([LIVE]),
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxBytes: 1024 * 1024 * 1024,
      removeDirectory: (dir) => {
        rmSync(dir, { recursive: true, force: true })
        return true
      }
    })

    expect(existsSync(live)).toBe(true)
    expect(existsSync(oldGone)).toBe(false)
    expect(existsSync(recentGone)).toBe(true)
    expect(existsSync(unknown)).toBe(true)
    expect(result.removedDirectories).toBe(1)
    expect(result.skippedReason).toBeNull()
  })

  it('removes nothing when the live worktree set is empty', async () => {
    const root = historyRoot()
    const oldGone = seed(root, 'gone-old', GONE, 40 * DAY)

    const result = await applyTerminalHistoryRetention({
      historyRoot: root,
      liveWorktreeIds: new Set(),
      now: NOW,
      maxAgeMs: DAY,
      removeDirectory: () => {
        throw new Error('must not delete')
      }
    })

    expect(existsSync(oldGone)).toBe(true)
    expect(result.removedDirectories).toBe(0)
    expect(result.skippedReason).toBe('empty-live-set')
  })
})
