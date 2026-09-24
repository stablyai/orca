import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { readFileSync as NodeReadFileSync } from 'node:fs'
import os, { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  cursorUsageSummaryCookie,
  getCursorCliAuthPath,
  getCursorDesktopStateDbPath,
  jwtSubject,
  readCursorAuthSession
} from './cursor-auth'

const fsMocks = vi.hoisted(() => ({
  readFileSync: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<{ readFileSync: typeof NodeReadFileSync }>()
  fsMocks.readFileSync.mockImplementation(actual.readFileSync)
  return { ...actual, readFileSync: fsMocks.readFileSync }
})

function mintJwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub }), 'utf8').toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

function isolateLinuxCursorConfig(dir: string): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.stubEnv('XDG_CONFIG_HOME', dir)
}

function isolateDarwinCursorHome(dir: string): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(os, 'homedir').mockReturnValue(dir)
}

describe('cursor-auth', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds the dashboard cookie from the JWT subject', () => {
    const token = mintJwt('auth0|user-1')
    expect(jwtSubject(token)).toBe('auth0|user-1')
    expect(cursorUsageSummaryCookie(token)).toBe(
      `WorkosCursorSessionToken=${encodeURIComponent('auth0|user-1')}%3A%3A${token}`
    )
  })

  it.each([
    {
      platform: 'darwin' as const,
      appData: '/ignored/appdata',
      xdg: '/ignored/xdg',
      desktop: join(
        homedir(),
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      ),
      cli: join(homedir(), '.cursor', 'auth.json')
    },
    {
      platform: 'win32' as const,
      appData: 'C:\\Users\\test\\AppData\\Roaming',
      xdg: '/ignored/xdg',
      desktop: join(
        'C:\\Users\\test\\AppData\\Roaming',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      ),
      cli: join('C:\\Users\\test\\AppData\\Roaming', 'Cursor', 'auth.json')
    },
    {
      platform: 'linux' as const,
      appData: '/ignored/appdata',
      xdg: '/tmp/xdg-config',
      desktop: join('/tmp/xdg-config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      cli: join('/tmp/xdg-config', 'cursor', 'auth.json')
    }
  ])(
    'resolves desktop and CLI auth paths on $platform',
    ({ platform, appData, xdg, desktop, cli }) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      vi.stubEnv('APPDATA', appData)
      vi.stubEnv('XDG_CONFIG_HOME', xdg)
      expect(getCursorDesktopStateDbPath()).toBe(desktop)
      expect(getCursorCliAuthPath()).toBe(cli)
    }
  )

  it('reads a desktop vscdb token without copying the database file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-auth-'))
    dirs.push(dir)
    const dbPath = join(dir, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    mkdirSync(join(dir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    const token = mintJwt('auth0|desktop')
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    insert.run('cursorAuth/accessToken', token)
    insert.run('cursorAuth/cachedEmail', 'dev@example.com')
    insert.run('cursorAuth/stripeMembershipType', 'ultra')
    insert.run('cursorAuth/stripeSubscriptionStatus', 'active')
    db.close()

    isolateLinuxCursorConfig(dir)
    expect(readCursorAuthSession()).toEqual({
      status: 'ok',
      session: {
        accessToken: token,
        subject: 'auth0|desktop',
        source: 'desktop',
        email: 'dev@example.com',
        membershipType: 'ultra',
        subscriptionStatus: 'active'
      }
    })
  })

  it('reads the macOS Application Support desktop database without copying it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-darwin-'))
    dirs.push(dir)
    const dbPath = join(
      dir,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb'
    )
    mkdirSync(join(dir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'), {
      recursive: true
    })
    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    const token = mintJwt('auth0|darwin-desktop')
    const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    insert.run('cursorAuth/accessToken', token)
    insert.run('cursorAuth/cachedEmail', 'dev@example.com')
    insert.run('cursorAuth/stripeMembershipType', 'ultra')
    insert.run('cursorAuth/stripeSubscriptionStatus', 'active')
    db.close()

    isolateDarwinCursorHome(dir)
    expect(getCursorDesktopStateDbPath()).toBe(dbPath)
    expect(readCursorAuthSession()).toEqual({
      status: 'ok',
      session: {
        accessToken: token,
        subject: 'auth0|darwin-desktop',
        source: 'desktop',
        email: 'dev@example.com',
        membershipType: 'ultra',
        subscriptionStatus: 'active'
      }
    })
  })

  it('falls back to CLI auth.json when the desktop DB is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-cli-'))
    dirs.push(dir)
    const token = mintJwt('auth0|cli')
    mkdirSync(join(dir, 'cursor'), { recursive: true })
    writeFileSync(join(dir, 'cursor', 'auth.json'), JSON.stringify({ accessToken: token }))
    isolateLinuxCursorConfig(dir)
    expect(readCursorAuthSession()).toEqual({
      status: 'ok',
      session: {
        accessToken: token,
        subject: 'auth0|cli',
        source: 'cli',
        email: null,
        membershipType: null,
        subscriptionStatus: null
      }
    })
  })

  it('returns missing when neither auth source exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-missing-'))
    dirs.push(dir)
    isolateLinuxCursorConfig(dir)
    expect(readCursorAuthSession()).toEqual({ status: 'missing' })
  })

  it('returns error when the desktop database is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-corrupt-'))
    dirs.push(dir)
    const dbPath = join(dir, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    mkdirSync(join(dir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
    writeFileSync(dbPath, 'not a sqlite database')
    isolateLinuxCursorConfig(dir)

    expect(readCursorAuthSession()).toEqual({
      status: 'error',
      error: 'Unable to read Cursor desktop auth'
    })
  })

  it('falls back to CLI auth.json when the desktop database is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-desktop-error-cli-'))
    dirs.push(dir)
    const token = mintJwt('auth0|cli-after-desktop-error')
    const dbPath = join(dir, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    mkdirSync(join(dir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
    writeFileSync(dbPath, 'not a sqlite database')
    mkdirSync(join(dir, 'cursor'), { recursive: true })
    writeFileSync(join(dir, 'cursor', 'auth.json'), JSON.stringify({ accessToken: token }))
    isolateLinuxCursorConfig(dir)

    expect(readCursorAuthSession()).toEqual({
      status: 'ok',
      session: {
        accessToken: token,
        subject: 'auth0|cli-after-desktop-error',
        source: 'cli',
        email: null,
        membershipType: null,
        subscriptionStatus: null
      }
    })
  })

  it('returns error when the desktop database is locked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-locked-'))
    dirs.push(dir)
    const dbPath = join(dir, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    mkdirSync(join(dir, 'Cursor', 'User', 'globalStorage'), { recursive: true })
    const db = new SyncDatabase(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('BEGIN EXCLUSIVE')
    isolateLinuxCursorConfig(dir)

    try {
      expect(readCursorAuthSession()).toEqual({
        status: 'error',
        error: 'Unable to read Cursor desktop auth'
      })
    } finally {
      db.exec('ROLLBACK')
      db.close()
    }
  })

  it('returns error when Cursor Agent auth.json is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-unreadable-'))
    dirs.push(dir)
    const authDir = join(dir, 'cursor')
    const authPath = join(authDir, 'auth.json')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(authPath, '{}')
    isolateLinuxCursorConfig(dir)
    fsMocks.readFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    expect(readCursorAuthSession()).toEqual({
      status: 'error',
      error: 'Unable to read Cursor Agent auth file'
    })
  })

  it('returns error when Cursor Agent auth.json is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-malformed-'))
    dirs.push(dir)
    const authDir = join(dir, 'cursor')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(join(authDir, 'auth.json'), '{')
    isolateLinuxCursorConfig(dir)

    expect(readCursorAuthSession()).toEqual({
      status: 'error',
      error: 'Cursor Agent auth file is invalid'
    })
  })
})
