import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_SESSION_LOG_MIN_RETAINED_ROLLOUTS,
  CODEX_SESSION_LOG_RETENTION_DAYS,
  pruneExpiredCodexSessionLogs,
  resolveCodexSessionLogRetentionDays
} from './codex-session-log-retention'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-28T00:00:00.000Z')

let workspaceRoot: string
let sessionsRoot: string

function writeRollout(relativePath: string, ageDays: number, contents = 'rollout\n'): string {
  const filePath = join(sessionsRoot, relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, contents)
  const modified = new Date(NOW - ageDays * DAY_MS)
  utimesSync(filePath, modified, modified)
  return filePath
}

function rolloutName(index: number): string {
  return `rollout-2026-01-01T00-00-00-${String(index).padStart(4, '0')}.jsonl`
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codex-session-log-retention-'))
  sessionsRoot = join(workspaceRoot, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('pruneExpiredCodexSessionLogs', () => {
  it('removes rollouts older than the retention window and keeps recent ones', async () => {
    const expired = writeRollout(join('2025', '09', '01', rolloutName(1)), 300)
    const recent = writeRollout(join('2026', '08', '20', rolloutName(2)), 8)

    const summary = await pruneExpiredCodexSessionLogs({
      sessionsRoot,
      now: NOW,
      minRetainedRollouts: 0
    })

    expect(existsSync(expired)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(summary.removedRollouts).toBe(1)
    expect(summary.scannedRollouts).toBe(2)
    expect(summary.failures).toBe(0)
  })

  it('keeps the newest rollouts even when every file is past the retention window', async () => {
    const paths = [0, 1, 2].map((index) =>
      writeRollout(join('2025', '09', '01', rolloutName(index)), 400 - index)
    )

    const summary = await pruneExpiredCodexSessionLogs({
      sessionsRoot,
      now: NOW,
      minRetainedRollouts: 2
    })

    expect(existsSync(paths[0])).toBe(false)
    expect(existsSync(paths[1])).toBe(true)
    expect(existsSync(paths[2])).toBe(true)
    expect(summary.removedRollouts).toBe(1)
  })

  it('leaves files that are not Codex rollouts alone', async () => {
    const notes = join(sessionsRoot, '2025', '09', '01', 'notes.txt')
    mkdirSync(join(notes, '..'), { recursive: true })
    writeFileSync(notes, 'keep me\n')
    const old = new Date(NOW - 400 * DAY_MS)
    utimesSync(notes, old, old)

    const summary = await pruneExpiredCodexSessionLogs({
      sessionsRoot,
      now: NOW,
      minRetainedRollouts: 0
    })

    expect(existsSync(notes)).toBe(true)
    expect(summary.scannedRollouts).toBe(0)
    expect(summary.removedRollouts).toBe(0)
  })

  it('removes date directories left empty but keeps the sessions root', async () => {
    writeRollout(join('2025', '09', '01', rolloutName(1)), 400)

    await pruneExpiredCodexSessionLogs({ sessionsRoot, now: NOW, minRetainedRollouts: 0 })

    expect(existsSync(join(sessionsRoot, '2025'))).toBe(false)
    expect(existsSync(sessionsRoot)).toBe(true)
  })

  it('keeps a date directory that still holds a retained rollout', async () => {
    writeRollout(join('2025', '09', '01', rolloutName(1)), 400)
    writeRollout(join('2025', '09', '01', rolloutName(2)), 1)

    await pruneExpiredCodexSessionLogs({ sessionsRoot, now: NOW, minRetainedRollouts: 0 })

    expect(existsSync(join(sessionsRoot, '2025', '09', '01'))).toBe(true)
  })

  it('reports an empty summary when the sessions root does not exist', async () => {
    const summary = await pruneExpiredCodexSessionLogs({
      sessionsRoot: join(workspaceRoot, 'missing'),
      now: NOW
    })

    expect(summary).toEqual({
      scannedRollouts: 0,
      removedRollouts: 0,
      removedBytes: 0,
      removedDirectories: 0,
      failures: 0
    })
  })

  it('counts a sessions root that is a file as a failure instead of treating it as absent', async () => {
    const filePath = join(workspaceRoot, 'sessions-as-file')
    writeFileSync(filePath, 'not a directory\n')

    const summary = await pruneExpiredCodexSessionLogs({
      sessionsRoot: filePath,
      now: NOW
    })

    // readdir() reports ENOTDIR here: the path exists, it is just the wrong
    // kind. Treating that as absence would report a clean sweep while nothing
    // was ever pruned.
    expect(summary.failures).toBe(1)
    expect(summary.scannedRollouts).toBe(0)
  })

  it('counts an unreadable directory as a failure instead of treating it as absent', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    writeRollout(join('2026', '08', '20', rolloutName(1)), 8)
    const lockedDirectory = join(sessionsRoot, '2025', '09', '01')
    mkdirSync(lockedDirectory, { recursive: true })
    chmodSync(lockedDirectory, 0o000)

    let summary
    try {
      summary = await pruneExpiredCodexSessionLogs({
        sessionsRoot,
        now: NOW,
        minRetainedRollouts: 0
      })
    } finally {
      chmodSync(lockedDirectory, 0o700)
    }

    expect(summary.failures).toBe(1)
    expect(summary.scannedRollouts).toBe(1)
  })

  it('counts an unreadable directory once even when the sweep also removes directories', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    // Why: the scan and the empty-directory cleanup both walk the tree, so an unreadable
    // directory is reachable twice in one sweep. Tallying the readdir failure in both places
    // reports two failures for one directory, which is no more accurate than reporting none.
    writeRollout(join('2025', '09', '01', rolloutName(1)), 300)
    const lockedDirectory = join(sessionsRoot, '2024', '01', '01')
    mkdirSync(lockedDirectory, { recursive: true })
    chmodSync(lockedDirectory, 0o000)

    let summary
    try {
      summary = await pruneExpiredCodexSessionLogs({
        sessionsRoot,
        now: NOW,
        minRetainedRollouts: 0
      })
    } finally {
      chmodSync(lockedDirectory, 0o700)
    }

    expect(summary.removedRollouts).toBe(1)
    expect(summary.failures).toBe(1)
  })

  it('deletes nothing while the default guard keeps the newest rollouts', async () => {
    const paths = Array.from(
      { length: CODEX_SESSION_LOG_MIN_RETAINED_ROLLOUTS },
      (_unused, index) => writeRollout(join('2025', '09', '01', rolloutName(index)), 400 - index)
    )

    const summary = await pruneExpiredCodexSessionLogs({ sessionsRoot, now: NOW })

    expect(summary.removedRollouts).toBe(0)
    expect(paths.every((filePath) => existsSync(filePath))).toBe(true)
  })
})

describe('resolveCodexSessionLogRetentionDays', () => {
  it('defaults to the built-in retention window', () => {
    expect(resolveCodexSessionLogRetentionDays({})).toBe(CODEX_SESSION_LOG_RETENTION_DAYS)
  })

  it('honours an explicit override', () => {
    expect(
      resolveCodexSessionLogRetentionDays({ ORCA_CODEX_SESSION_LOG_RETENTION_DAYS: '14' })
    ).toBe(14)
  })

  it('treats 0 as opt-out', () => {
    expect(
      resolveCodexSessionLogRetentionDays({ ORCA_CODEX_SESSION_LOG_RETENTION_DAYS: '0' })
    ).toBeNull()
  })

  it('falls back to the default for values that are not positive numbers', () => {
    for (const value of ['', 'soon', '-5', 'NaN']) {
      expect(
        resolveCodexSessionLogRetentionDays({ ORCA_CODEX_SESSION_LOG_RETENTION_DAYS: value })
      ).toBe(CODEX_SESSION_LOG_RETENTION_DAYS)
    }
  })
})
