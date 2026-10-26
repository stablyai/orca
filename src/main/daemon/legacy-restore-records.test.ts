import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LegacyRestoreRecords,
  legacyRestoreRecordsPathFor,
  type LegacyRestoreDetails
} from './legacy-restore-records'
import { DEFAULT_MAX_HOST_TERMINALS } from './host-terminal-ledger'

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

  it('keeps one record per restore, the newest refusal winning', () => {
    const records = open()
    records.record(details(), 'pressure')
    now += 1000
    records.record(details({ sessionId: 'wt-1@@bbbb2222' }), 'host_cap')
    expect(records.list()).toEqual([
      { ...details({ sessionId: 'wt-1@@bbbb2222' }), reason: 'host_cap', refusedAt: now }
    ])
  })

  it('drops the record once the same agent session starts', () => {
    const records = open()
    records.record(details({ identityDigest: 'd'.repeat(43) }), 'pressure')
    records.record(details({ command: 'codex resume 9a', agent: 'codex' }), 'pressure')
    records.clearStarted(details({ identityDigest: 'd'.repeat(43), command: 'other' }))
    records.clearStarted(details({ command: 'codex resume 9a', agent: 'codex' }))
    expect(open().list()).toEqual([])
  })

  it('keeps the newest records within its bound and forgets old ones', () => {
    const records = open()
    for (let i = 0; i < DEFAULT_MAX_HOST_TERMINALS + 8; i++) {
      records.record(details({ command: `claude --resume ${i}` }), 'pressure')
    }
    expect(records.list()).toHaveLength(DEFAULT_MAX_HOST_TERMINALS)
    expect(records.list()[0]?.command).toBe(`claude --resume ${DEFAULT_MAX_HOST_TERMINALS + 7}`)
    expect(records.list().at(-1)?.command).toBe('claude --resume 8')
    now += 15 * 24 * 60 * 60_000
    expect(open().list()).toEqual([])
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

  it('lives beside the daemon run marker', () => {
    expect(legacyRestoreRecordsPathFor('/data/daemon/daemon-v44.automatic-work-run.json')).toBe(
      '/data/daemon/daemon-v44.legacy-restores.json'
    )
  })
})
