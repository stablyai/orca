import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMigrationJournalDirectory } from './migration-journal-directory'

type JournalRecord = { migrationId: string }

const journalOptions = {
  directoryName: 'journal',
  maxFileBytes: 1024,
  parse: (value: unknown): JournalRecord => {
    if (typeof value !== 'object' || value === null || !('migrationId' in value)) {
      throw new Error('not a record')
    }
    return { migrationId: String(value.migrationId) }
  },
  unreadable: (detail: string) => new Error(detail)
}
const journal = createMigrationJournalDirectory<JournalRecord>({
  ...journalOptions,
  sweepOrphanedTemporaries: true
})

// The sweep compares a file's mtime with the clock, so both read this fixed time.
const NOW = Date.UTC(2026, 9, 24, 12)

let userDataPath: string
let dir: string
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  userDataPath = mkdtempSync(join(tmpdir(), 'migration-journal-'))
  dir = join(userDataPath, 'journal')
  mkdirSync(dir)
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

function temporary(pid: number, ageMs: number): string {
  const path = join(dir, `move-1.json.${pid}.1792672615854.b6fca333.tmp`)
  writeFileSync(path, '{')
  const at = (NOW - ageMs) / 1000
  utimesSync(path, at, at)
  return path
}

describe('migration journal directory', () => {
  it("removes another process's write that died before its rename", () => {
    // A killed journal write left `<id>.json.<pid>.<ts>.tmp` behind forever.
    const orphan = temporary(process.pid + 1, 120_000)
    expect(journal.list(userDataPath)).toEqual([])
    expect(existsSync(orphan)).toBe(false)
  })

  it("keeps this process's own write and one another process may still be finishing", () => {
    const own = temporary(process.pid, 120_000)
    const recent = temporary(process.pid + 1, 0)
    expect(journal.list(userDataPath)).toEqual([])
    expect(existsSync(own)).toBe(true)
    expect(existsSync(recent)).toBe(true)
  })

  it('leaves temporaries alone in a journal that does not sweep, as SSH migration journals do', () => {
    const orphan = temporary(process.pid + 1, 120_000)
    const unswept = createMigrationJournalDirectory<JournalRecord>(journalOptions)
    expect(unswept.list(userDataPath)).toEqual([])
    expect(existsSync(orphan)).toBe(true)
  })
})
