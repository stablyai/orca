import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  applyPendingBrowserCookieImports,
  clearPendingBrowserCookieImportNonTransplantable,
  setPendingBrowserCookieImport
} from './browser-session-cookie-staging'

const PARTITION = 'persist:work'
const DEFAULT_PARTITION = 'persist:default'

let workDir: string
let metadataPath: string
let stagedPath: string

function target() {
  return {
    resolveMetadataPath: () => metadataPath,
    defaultPartition: DEFAULT_PARTITION,
    partition: PARTITION
  }
}

function writeStagedDb(rows: readonly { host: string; name: string }[]): void {
  const db = new DatabaseSync(stagedPath)
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT)')
  const insert = db.prepare('INSERT INTO cookies (host_key, name) VALUES (?, ?)')
  for (const row of rows) {
    insert.run(row.host, row.name)
  }
  db.close()
}

function stagedRows(): { host_key: string; name: string }[] {
  const db = new DatabaseSync(stagedPath, { readOnly: true })
  try {
    return db.prepare('SELECT host_key, name FROM cookies ORDER BY name').all() as never
  } finally {
    db.close()
  }
}

function pendingEntries(): Record<string, string> {
  // Why: read the file the staging module actually persists, not a stubbed accessor.
  return JSON.parse(readFileSync(metadataPath, 'utf-8')).pendingCookieImports
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'orca-staging-google-clear-'))
  metadataPath = join(workDir, 'browser-session-meta.json')
  stagedPath = join(workDir, 'Cookies-staged')
  writeFileSync(metadataPath, JSON.stringify({ pendingCookieImports: {} }))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('clearPendingBrowserCookieImportNonTransplantable', () => {
  // Why (#14686): the staged DB is a copy of the live jar with ONLY the google.com rows kept, and a
  // cold start copies it back over the jar. Without this, a confirmed "Clear Google cookies" is
  // undone at the next launch and the user is signed back in with no signal.
  it('drops the google.com family from a pending staged import and keeps everything else', () => {
    writeStagedDb([
      { host: '.google.com', name: 'SID' },
      { host: 'accounts.google.com', name: 'ACCOUNT' },
      { host: '.withgoogle.com', name: 'LOOKALIKE' },
      { host: '.github.com', name: 'user_session' }
    ])
    setPendingBrowserCookieImport({ ...target(), stagingDbPath: stagedPath })

    clearPendingBrowserCookieImportNonTransplantable(target())

    expect(stagedRows()).toEqual([
      { host_key: '.withgoogle.com', name: 'LOOKALIKE' },
      { host_key: '.github.com', name: 'user_session' }
    ])
    // Why: the rest of the restart fallback must survive — the user cleared Google, not the import.
    expect(pendingEntries()).toEqual({ [PARTITION]: stagedPath })
  })

  it('leaves other partitions of a pending import untouched', () => {
    const otherStaged = join(workDir, 'Cookies-other')
    writeStagedDb([{ host: '.google.com', name: 'SID' }])
    setPendingBrowserCookieImport({ ...target(), stagingDbPath: stagedPath })
    setPendingBrowserCookieImport({
      ...target(),
      partition: 'persist:other',
      stagingDbPath: otherStaged
    })

    clearPendingBrowserCookieImportNonTransplantable(target())

    expect(pendingEntries()['persist:other']).toBe(otherStaged)
  })

  // Why: keeping an unreadable staged DB would replay the cleared session back. Dropping the replay
  // loses cookies that still needed a restart, which the user can re-import; a resurrected Google
  // session they explicitly deleted is the worse failure.
  it('drops the pending replay entirely when the staged database cannot be edited', () => {
    writeFileSync(stagedPath, 'not a sqlite database')
    setPendingBrowserCookieImport({ ...target(), stagingDbPath: stagedPath })

    clearPendingBrowserCookieImportNonTransplantable(target())

    expect(pendingEntries()).toEqual({})
    expect(existsSync(stagedPath)).toBe(false)
  })

  it('does nothing when the partition has no pending import', () => {
    expect(() => clearPendingBrowserCookieImportNonTransplantable(target())).not.toThrow()
    expect(pendingEntries()).toEqual({})
  })
})

describe('applyPendingBrowserCookieImports cleanup', () => {
  // Why (#14686): third route to the same leak. Delete a profile while its import is in flight and
  // no mark moves, so the entry is only dropped here at next start — by which point the staged DB,
  // a full copy of that profile's jar, has nothing left pointing at it and no sweeper to reclaim it.
  it('unlinks the staged database of a partition that is no longer a known profile', () => {
    writeStagedDb([{ host: '.google.com', name: 'SID' }])
    writeFileSync(`${stagedPath}-wal`, 'wal')
    setPendingBrowserCookieImport({ ...target(), stagingDbPath: stagedPath })

    applyPendingBrowserCookieImports({
      resolveMetadataPath: () => metadataPath,
      defaultPartition: DEFAULT_PARTITION,
      activeOrcaProfileId: 'local'
    })

    expect(existsSync(stagedPath)).toBe(false)
    expect(existsSync(`${stagedPath}-wal`)).toBe(false)
    expect(pendingEntries()).toEqual({})
  })
})
