import { copyFileSync, existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  sessionFromPartitionMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock,
  disposeStoreMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn(),
  disposeStoreMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: { clearPendingCookieImport: clearPendingCookieImportMock }
}))
vi.mock('./cookies/browser-cookie-clear-store', () => ({
  openCookieClearStore: () => ({
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: disposeStoreMock
  })
}))

import { createChromiumCookieTestDatabase } from './cookies/browser-cookie-import-test-database'
import {
  applyPendingBrowserCookieImports,
  clearPendingBrowserCookieImport
} from './browser-session-cookie-staging'
import { importChromiumCookies } from './cookies/chromium/import-cookies'
import { loadBrowserSessionMeta, persistBrowserSessionMeta } from './browser-session-meta-store'

const PARTITION = 'persist:test'

type CookieRow = { host_key: string; name: string; value: string }

function insertCookie(database: DatabaseSync, domain: string, name: string, value: string): void {
  database
    .prepare(
      `INSERT INTO cookies (
        creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path,
        expires_utc, is_secure, is_httponly, samesite, source_scheme, source_port,
        last_update_utc, has_cross_site_ancestor
      ) VALUES (1, ?, '', ?, ?, X'', '/', 0, 0, 0, 0, 0, -1, 0, 0)`
    )
    .run(domain, name, value)
}

function readCookies(databasePath: string): CookieRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database
      .prepare('SELECT host_key, name, value FROM cookies ORDER BY host_key, name')
      .all() as CookieRow[]
  } finally {
    database.close()
  }
}

describe('scoped pending browser cookie imports', () => {
  let tmpDir: string
  let livePath: string
  let metaPath: string
  let stagedPath: string
  let lifecycle: string[]

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-scoped-cookie-replay-'))
    livePath = join(tmpDir, 'Partitions', 'test', 'Network', 'Cookies')
    metaPath = join(tmpDir, 'browser-session-meta.json')
    stagedPath = join(tmpDir, 'staged-cookies')
    lifecycle = []
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(tmpDir)
    clearPendingCookieImportMock.mockReset().mockImplementation((partition: string) => {
      lifecycle.push('clear')
      clearPendingBrowserCookieImport({
        resolveMetadataPath: () => metaPath,
        defaultPartition: PARTITION,
        partition
      })
    })
    writeCookieIdentityMock
      .mockReset()
      .mockImplementation(async (identity: { name: string; value: string }) => {
        lifecycle.push('write')
        const live = new DatabaseSync(livePath)
        try {
          live
            .prepare('UPDATE cookies SET value = ? WHERE name = ?')
            .run(identity.value, identity.name)
        } finally {
          live.close()
        }
      })
    disposeStoreMock.mockReset().mockImplementation(() => {
      lifecycle.push('dispose')
    })
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: {
        flushStore: vi.fn(async () => {
          lifecycle.push(existsSync(stagedPath) ? 'flush-with-pending-stage' : 'flush')
        })
      },
      getStoragePath: () => {
        throw new Error('native import must not read target storage')
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function markPending(): void {
    persistBrowserSessionMeta(() => metaPath, PARTITION, {
      pendingCookieImports: { [PARTITION]: { format: 'scoped-v1', path: stagedPath } }
    })
  }

  function applyPending(): void {
    applyPendingBrowserCookieImports({
      resolveMetadataPath: () => metaPath,
      defaultPartition: PARTITION,
      activeOrcaProfileId: 'test-profile'
    })
  }

  function createScopedStage(): void {
    copyFileSync(livePath, stagedPath)
    const staged = new DatabaseSync(stagedPath)
    try {
      // Shipped scoped-v1 image: retain this fixture independently of the removed importer writer.
      staged.exec(`
        CREATE TABLE orca_cookie_import_scope (domain TEXT PRIMARY KEY, format_version INTEGER NOT NULL);
        INSERT INTO orca_cookie_import_scope VALUES ('a.example.com', 1);
        DELETE FROM cookies WHERE host_key IN ('.example.com', '.a.example.com', 'child.a.example.com');
      `)
      insertCookie(staged, '.a.example.com', 'new-a', 'imported')
    } finally {
      staged.close()
    }
  }

  it('preserves unrelated cookies changed after staging while merging imported domains', () => {
    createChromiumCookieTestDatabase(
      livePath,
      [
        { domain: '.example.com', name: 'parent', value: 'stale-parent' },
        { domain: '.a.example.com', name: 'old-a', value: 'stale' },
        { domain: 'child.a.example.com', name: 'child', value: 'stale-child' },
        { domain: '.unrelated.example.com', name: 'session', value: 'before-stage' }
      ],
      { journalMode: 'wal' }
    ).close()
    createScopedStage()
    expect(existsSync(`${stagedPath}-wal`)).toBe(false)
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 31))
    const dormant = new Date(Date.UTC(2026, 0, 1))
    utimesSync(stagedPath, dormant, dormant)

    const changedLive = new DatabaseSync(livePath)
    changedLive
      .prepare("UPDATE cookies SET value = 'rotated-after-stage' WHERE name = 'session'")
      .run()
    insertCookie(changedLive, '.another.example.com', 'new-login', 'created-after-stage')
    changedLive.close()
    markPending()

    applyPending()

    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'new-a', value: 'imported' },
      { host_key: '.another.example.com', name: 'new-login', value: 'created-after-stage' },
      { host_key: '.unrelated.example.com', name: 'session', value: 'rotated-after-stage' }
    ])
    expect(existsSync(stagedPath)).toBe(false)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
  })

  it('rolls back the merge and keeps the staged retry when an insert fails', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'keep-on-failure' },
      { domain: '.unrelated.example.com', name: 'session', value: 'live' }
    ]).close()
    createScopedStage()
    const rejectingLive = new DatabaseSync(livePath)
    rejectingLive.exec(`
      CREATE TRIGGER reject_staged_cookie BEFORE INSERT ON cookies
      WHEN NEW.name = 'new-a'
      BEGIN
        SELECT RAISE(ABORT, 'forced staged insert failure');
      END
    `)
    rejectingLive.close()
    markPending()

    applyPending()

    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'old-a', value: 'keep-on-failure' },
      { host_key: '.unrelated.example.com', name: 'session', value: 'live' }
    ])
    expect(existsSync(stagedPath)).toBe(true)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({
      [PARTITION]: { format: 'scoped-v1', path: stagedPath }
    })
    // Closed SQLite handles let Windows copy the retry file.
    expect(() => copyFileSync(stagedPath, `${stagedPath}.copy`)).not.toThrow()
  })

  it('retries a transient failure, then consumes the stage once and preserves later site updates', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'old' }
    ]).close()
    createScopedStage()
    markPending()
    const locked = new DatabaseSync(livePath)
    locked.exec('BEGIN IMMEDIATE')
    applyPending()
    expect(existsSync(stagedPath)).toBe(true)
    locked.exec('ROLLBACK')
    locked.close()
    applyPending()
    expect(existsSync(stagedPath)).toBe(false)
    const changed = new DatabaseSync(livePath)
    changed.prepare("UPDATE cookies SET value = 'rotated' WHERE name = 'new-a'").run()
    changed.close()
    applyPending()
    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'new-a', value: 'rotated' }
    ])
  })

  it('retires a SQLITE_BUSY-retained shipped stage before a newer native import can be replayed over', async () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'sid', value: 'working' }
    ]).close()
    createScopedStage()
    const staged = new DatabaseSync(stagedPath)
    staged
      .prepare("UPDATE cookies SET name = 'sid', value = 'old-shipped' WHERE name = 'new-a'")
      .run()
    staged.close()
    markPending()
    const locked = new DatabaseSync(livePath)
    try {
      locked.exec('BEGIN IMMEDIATE')
      applyPending()
      expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({
        [PARTITION]: { format: 'scoped-v1', path: stagedPath }
      })
      expect(existsSync(stagedPath)).toBe(true)
      expect(readCookies(livePath)[0].value).toBe('working')
    } finally {
      locked.exec('ROLLBACK')
      locked.close()
    }
    const source = join(tmpDir, 'source', 'Cookies')
    createChromiumCookieTestDatabase(source, [
      { domain: '.a.example.com', name: 'sid', value: 'new' }
    ]).close()
    const result = await importChromiumCookies(
      {
        family: 'chrome',
        label: 'Chrome',
        cookiesPath: source,
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      },
      PARTITION
    )
    expect(result).toMatchObject({ ok: true, summary: { importedCookies: 1 } })
    expect(lifecycle).toEqual(['write', 'dispose', 'clear', 'flush'])
    expect(clearPendingCookieImportMock).toHaveBeenCalledExactlyOnceWith(PARTITION)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
    expect(existsSync(stagedPath)).toBe(false)
    applyPending()
    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'sid', value: 'new' }
    ])
  })

  it.each([
    'all-rejected',
    'zero-decrypted',
    'scan-refusal',
    'empty-source',
    'missing-source',
    'store-error'
  ])('preserves main supersession boundary for %s', async (outcome) => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'sid', value: 'working' }
    ]).close()
    createScopedStage()
    markPending()
    const source = join(tmpDir, 'source', 'Cookies')
    if (outcome !== 'missing-source') {
      createChromiumCookieTestDatabase(
        source,
        outcome === 'empty-source'
          ? []
          : [
              {
                domain: outcome === 'zero-decrypted' ? '.google.com' : '.a.example.com',
                name: 'sid',
                value: 'new',
                ...(outcome === 'scan-refusal' ? { topFrameSiteKey: 'not-a-site' } : {})
              }
            ]
      ).close()
    }
    if (outcome === 'all-rejected') {
      writeCookieIdentityMock.mockRejectedValue(new Error('cookie rejected'))
    }
    if (outcome === 'store-error') {
      disposeStoreMock.mockImplementationOnce(() => {
        throw new Error('dispose failed')
      })
    }
    const result = await importChromiumCookies(
      {
        family: 'chrome',
        label: 'Chrome',
        cookiesPath: source,
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      },
      PARTITION,
      { canReportPartitionSkippedCookies: false }
    )
    const completed = outcome === 'all-rejected'
    expect(result.ok).toBe(completed || outcome === 'zero-decrypted')
    expect(clearPendingCookieImportMock).toHaveBeenCalledTimes(completed ? 1 : 0)
    expect(existsSync(stagedPath)).toBe(!completed)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual(
      completed
        ? {}
        : {
            [PARTITION]: { format: 'scoped-v1', path: stagedPath }
          }
    )
  })

  it('expires an old transient failure while keeping the live jar intact', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'old' }
    ]).close()
    createScopedStage()
    markPending()
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 31))
    const old = new Date(Date.UTC(2026, 0, 16))
    utimesSync(stagedPath, old, old)
    const locked = new DatabaseSync(livePath)
    locked.exec('BEGIN IMMEDIATE')
    applyPending()
    locked.exec('ROLLBACK')
    locked.close()
    expect(existsSync(stagedPath)).toBe(false)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'old-a', value: 'old' }
    ])
  })

  it('consumes a shipped scoped record when an inactive profile is first accessed after upgrading', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'old' }
    ]).close()
    createScopedStage()
    markPending()
    applyPendingBrowserCookieImports({
      resolveMetadataPath: () => join(tmpDir, 'other-profile-meta.json'),
      defaultPartition: 'persist:other',
      activeOrcaProfileId: 'other-profile'
    })
    expect(existsSync(stagedPath)).toBe(true)
    applyPending()
    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'new-a', value: 'imported' }
    ])
    expect(existsSync(stagedPath)).toBe(false)
  })

  it('removes a known scoped record whose marker is missing without touching the live jar', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'sid', value: 'working' }
    ]).close()
    copyFileSync(livePath, stagedPath)
    markPending()
    applyPending()
    expect(existsSync(stagedPath)).toBe(false)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'sid', value: 'working' }
    ])
  })

  it('copies a scoped image when the live cookie database no longer exists', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'stale' },
      { domain: '.unrelated.example.com', name: 'session', value: 'preserved' }
    ]).close()
    createScopedStage()
    rmSync(livePath)
    markPending()

    applyPending()

    const replayedPath = join(tmpDir, 'Partitions', 'test', 'Cookies')
    expect(readCookies(replayedPath)).toEqual([
      { host_key: '.a.example.com', name: 'new-a', value: 'imported' },
      { host_key: '.unrelated.example.com', name: 'session', value: 'preserved' }
    ])
    const replayed = new DatabaseSync(replayedPath, { readOnly: true })
    expect(
      replayed
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orca_%'")
        .all()
    ).toEqual([])
    replayed.close()
    expect(existsSync(stagedPath)).toBe(false)
  })

  it.each(['string', 'top-level'])(
    'expires an old legacy %s record without applying it over the live jar',
    (format) => {
      createChromiumCookieTestDatabase(livePath, [
        { domain: '.live.example', name: 'live', value: 'replaced' }
      ]).close()
      createChromiumCookieTestDatabase(stagedPath, [
        { domain: '.legacy.example', name: 'legacy', value: 'pending' }
      ]).close()
      vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 31))
      const old = new Date(Date.UTC(2026, 0, 16))
      utimesSync(stagedPath, old, old)
      persistBrowserSessionMeta(() => metaPath, PARTITION, {
        pendingCookieImports: format === 'string' ? { [PARTITION]: stagedPath } : {},
        pendingCookieDbPath: stagedPath
      })

      applyPending()

      expect(readCookies(livePath)).toEqual([
        { host_key: '.live.example', name: 'live', value: 'replaced' }
      ])
      expect(existsSync(stagedPath)).toBe(false)
      expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
    }
  )

  it('fails closed across cookie schema drift without mutating the live jar', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'keep-on-mismatch' }
    ]).close()
    createScopedStage()
    const changedSchema = new DatabaseSync(livePath)
    changedSchema.exec("ALTER TABLE cookies ADD COLUMN future_required TEXT NOT NULL DEFAULT 'v'")
    changedSchema.close()
    markPending()

    applyPending()

    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'old-a', value: 'keep-on-mismatch' }
    ])
    expect(existsSync(stagedPath)).toBe(false)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
  })

  it('fails closed on an unknown staged scope format', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'keep-on-unknown-format' }
    ]).close()
    createScopedStage()
    const invalidStage = new DatabaseSync(stagedPath)
    invalidStage.exec('UPDATE orca_cookie_import_scope SET format_version = 999')
    invalidStage.close()
    markPending()

    applyPending()

    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'old-a', value: 'keep-on-unknown-format' }
    ])
    expect(existsSync(stagedPath)).toBe(false)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
  })

  it('leaves a future pending-import format untouched', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.a.example.com', name: 'old-a', value: 'keep-for-newer-build' }
    ]).close()
    createScopedStage()
    persistBrowserSessionMeta(() => metaPath, PARTITION, {
      pendingCookieImports: {
        [PARTITION]: { format: 'scoped-v2', path: stagedPath }
      },
      pendingCookieDbPath: null
    })

    applyPending()

    expect(readCookies(livePath)).toEqual([
      { host_key: '.a.example.com', name: 'old-a', value: 'keep-for-newer-build' }
    ])
    expect(existsSync(stagedPath)).toBe(true)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({
      [PARTITION]: { format: 'scoped-v2', path: stagedPath }
    })
  })
})
