import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backfillManagedCodexSessionsIntoSystemHome } from './codex-session-backfill'
import type { CodexSessionBackfillPaths } from './codex-session-backfill-types'
import { pruneExpiredCodexSessionLogs } from './codex-session-log-retention'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-28T00:00:00.000Z')
const ROLLOUT_RELATIVE_PATH = join(
  '2025',
  '09',
  '01',
  'rollout-2025-09-01T00-00-00-00000000-0000-0000-0000-000000000001.jsonl'
)

let workspaceRoot: string
let paths: CodexSessionBackfillPaths

function writeExpiredManagedRollout(): string {
  const filePath = join(paths.managedSessionsRoot, ROLLOUT_RELATIVE_PATH)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, 'history\n')
  const modified = new Date(NOW - 300 * DAY_MS)
  utimesSync(filePath, modified, modified)
  return filePath
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codex-session-log-retention-migration-'))
  paths = {
    managedSessionsRoot: join(workspaceRoot, 'managed', 'sessions'),
    systemSessionsRoot: join(workspaceRoot, 'system', 'sessions'),
    auditLogPath: join(workspaceRoot, 'state', 'audit.jsonl'),
    markerPath: join(workspaceRoot, 'state', 'backfill-complete.json')
  }
  mkdirSync(join(workspaceRoot, 'state'), { recursive: true })
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

// Why: startup runs the sweep immediately while the session migration waits for
// its initial delay, so the sweep sees managed rollouts the migration has not
// published into the real Codex home yet.
describe('retention sweep vs. session migration', () => {
  it('keeps an expired rollout the migration has not published yet, then prunes it once published', async () => {
    const managedRollout = writeExpiredManagedRollout()
    const systemRollout = join(paths.systemSessionsRoot, ROLLOUT_RELATIVE_PATH)

    const beforeMigration = await pruneExpiredCodexSessionLogs({
      sessionsRoot: paths.managedSessionsRoot,
      now: NOW,
      minRetainedRollouts: 0,
      publishedSessionsRoot: paths.systemSessionsRoot
    })
    expect(beforeMigration.removedRollouts).toBe(0)
    expect(existsSync(managedRollout)).toBe(true)

    const migration = await backfillManagedCodexSessionsIntoSystemHome(paths)
    expect(migration.linkedFiles).toBe(1)
    // A hardlink shares the inode, so the published copy keeps the old mtime.
    expect(statSync(systemRollout).mtimeMs).toBe(statSync(managedRollout).mtimeMs)

    const afterMigration = await pruneExpiredCodexSessionLogs({
      sessionsRoot: paths.managedSessionsRoot,
      now: NOW,
      minRetainedRollouts: 0,
      publishedSessionsRoot: paths.systemSessionsRoot
    })
    expect(afterMigration.removedRollouts).toBe(1)
    expect(existsSync(managedRollout)).toBe(false)
    expect(readFileSync(systemRollout, 'utf-8')).toBe('history\n')
  })

  it('without a published root, a sweep that runs before migration destroys the only copy', async () => {
    writeExpiredManagedRollout()

    await pruneExpiredCodexSessionLogs({
      sessionsRoot: paths.managedSessionsRoot,
      now: NOW,
      minRetainedRollouts: 0
    })
    const migration = await backfillManagedCodexSessionsIntoSystemHome(paths)

    expect(migration.linkedFiles).toBe(0)
    expect(existsSync(join(paths.systemSessionsRoot, ROLLOUT_RELATIVE_PATH))).toBe(false)
  })
})
