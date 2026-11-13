import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyRestoreRecords, type LegacyRestoreDetails } from '../legacy-restore-records'

const details = (overrides: Partial<LegacyRestoreDetails> = {}): LegacyRestoreDetails => ({
  sessionId: 'wt-1@@aaaa1111',
  agent: 'claude',
  cwd: '/repo',
  command: 'claude --resume 6f1c',
  worktreeId: 'wt-1',
  identityDigest: null,
  ...overrides
})

describe('LegacyRestoreRecords', () => {
  let dir: string
  let path: string
  let now: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-legacy-restores-'))
    path = join(dir, 'daemon-v44.legacy-restores.json')
    now = 1_000_000
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const open = () => new LegacyRestoreRecords(path, { log: vi.fn() }, () => now)

  it('keeps a refused restore across a daemon restart, private to the user', () => {
    open().record(details(), 'pressure')
    expect(open().list()).toEqual([{ ...details(), reason: 'pressure', refusedAt: now }])
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0)
    }
  })

  it('treats an unreadable file as empty and never throws into a spawn', () => {
    writeFileSync(path, '{not json')
    const records = open()
    expect(records.list()).toEqual([])
    records.record(details(), 'pressure')
    expect(JSON.parse(readFileSync(path, 'utf8')).records).toHaveLength(1)
    const unwritable = new LegacyRestoreRecords(join(dir, 'missing', 'x.json'), { log: vi.fn() })
    expect(() => unwritable.record(details(), 'pressure')).not.toThrow()
  })
})
