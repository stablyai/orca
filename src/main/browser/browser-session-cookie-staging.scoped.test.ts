import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetPathMock } = vi.hoisted(() => ({ appGetPathMock: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: appGetPathMock } }))

import { importedDomainScope } from './browser-cookie-import-policy'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { prepareStagedCookiesForImport } from './browser-cookie-staged-import'
import {
  applyPendingBrowserCookieImports,
  setPendingBrowserCookieImport
} from './browser-session-cookie-staging'
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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-scoped-cookie-replay-'))
    livePath = join(tmpDir, 'Partitions', 'test', 'Network', 'Cookies')
    metaPath = join(tmpDir, 'browser-session-meta.json')
    stagedPath = join(tmpDir, 'staged-cookies')
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function markPending(): void {
    setPendingBrowserCookieImport({
      resolveMetadataPath: () => metaPath,
      defaultPartition: PARTITION,
      partition: PARTITION,
      stagingDbPath: stagedPath
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
      prepareStagedCookiesForImport(staged, importedDomainScope(['a.example.com']))
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
    // Why: both SQLite handles must be closed after failure so Windows can read the retry file.
    expect(() => copyFileSync(stagedPath, `${stagedPath}.copy`)).not.toThrow()
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

    // With neither modern nor legacy DB present, replay uses Chromium's legacy fallback path.
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

  it('keeps whole-image replay for legacy staged databases without a scope marker', () => {
    createChromiumCookieTestDatabase(livePath, [
      { domain: '.live.example', name: 'live', value: 'replaced' }
    ]).close()
    createChromiumCookieTestDatabase(stagedPath, [
      { domain: '.legacy.example', name: 'legacy', value: 'pending' }
    ]).close()
    persistBrowserSessionMeta(() => metaPath, PARTITION, {
      pendingCookieImports: { [PARTITION]: stagedPath },
      pendingCookieDbPath: stagedPath
    })

    applyPending()

    expect(readCookies(livePath)).toEqual([
      { host_key: '.legacy.example', name: 'legacy', value: 'pending' }
    ])
    expect(existsSync(stagedPath)).toBe(false)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({})
  })

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
    expect(existsSync(stagedPath)).toBe(true)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({
      [PARTITION]: { format: 'scoped-v1', path: stagedPath }
    })
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
    expect(existsSync(stagedPath)).toBe(true)
    expect(loadBrowserSessionMeta(() => metaPath, PARTITION).pendingCookieImports).toEqual({
      [PARTITION]: { format: 'scoped-v1', path: stagedPath }
    })
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
