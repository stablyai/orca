import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'

const resumed = vi.hoisted(() => ({ path: '', statCalls: 0 }))

// Why: the race this pins is between the scan's stat and the unlink, and only a real resume in
// that window reproduces it. The mock keeps every other fs call real - the file that survives is
// the one still on disk - and uses the sweep's own second stat as the moment to touch the file,
// which is exactly when Codex would have appended to it.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    stat: async (path: string) => {
      if (path !== resumed.path) {
        return actual.stat(path)
      }
      resumed.statCalls += 1
      if (resumed.statCalls === 2) {
        const now = new Date()
        await actual.utimes(path, now, now)
      }
      return actual.stat(path)
    }
  }
})

import { pruneExpiredCodexSessionLogs } from './codex-session-log-retention'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-28T00:00:00.000Z')

let workspaceRoot: string
let sessionsRoot: string

function writeRollout(name: string, ageDays: number): string {
  const filePath = join(sessionsRoot, '2025', '09', '01', name)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, 'rollout\n')
  const modified = new Date(NOW - ageDays * DAY_MS)
  utimesSync(filePath, modified, modified)
  return filePath
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codex-retention-race-'))
  sessionsRoot = join(workspaceRoot, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  resumed.path = ''
  resumed.statCalls = 0
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('pruneExpiredCodexSessionLogs concurrency', () => {
  it('keeps a rollout that Codex resumed after the scan sampled its mtime', async () => {
    const resumedRollout = writeRollout('rollout-2025-09-01T00-00-00-resumed.jsonl', 400)
    const stale = writeRollout('rollout-2025-09-01T00-00-00-stale.jsonl', 400)
    resumed.path = resumedRollout

    const summary = await pruneExpiredCodexSessionLogs({
      sessionsRoot,
      now: NOW,
      minRetainedRollouts: 0
    })

    // The resumed session is live again: unlinking it would drop it from discovery and send
    // every later append into a file no path points at.
    expect(existsSync(resumedRollout)).toBe(true)
    // The sweep still reclaims everything that really is untouched.
    expect(existsSync(stale)).toBe(false)
    expect(summary.removedRollouts).toBe(1)
    expect(summary.scannedRollouts).toBe(2)
    // A skip is not a failure - nothing went wrong, the file simply stopped being expired.
    expect(summary.failures).toBe(0)
  })
})
