import { describe, expect, it } from 'vitest'
import { getHermesHome, readNousAuthSession } from './nous-auth'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function withHermesHome(home: string, run: () => void): void {
  const previous = process.env.HERMES_HOME
  process.env.HERMES_HOME = home
  try {
    run()
  } finally {
    if (previous === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = previous
    }
  }
}

function writeAuthFile(home: string, payload: unknown): void {
  writeFileSync(join(home, 'auth.json'), JSON.stringify(payload))
}

describe('readNousAuthSession', () => {
  it('returns missing when the auth file does not exist', () => {
    withHermesHome(mkdtempSync(join(tmpdir(), 'nous-auth-test-')), () => {
      expect(readNousAuthSession()).toEqual({ status: 'missing' })
    })
  })

  it('returns error on a malformed auth file', () => {
    const home = mkdtempSync(join(tmpdir(), 'nous-auth-test-'))
    writeFileSync(join(home, 'auth.json'), '{not json')
    withHermesHome(home, () => {
      const result = readNousAuthSession()
      expect(result.status).toBe('error')
    })
    rmSync(home, { recursive: true, force: true })
  })

  it('returns missing when the nous provider block is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'nous-auth-test-'))
    writeAuthFile(home, { active_provider: 'openrouter', providers: {} })
    withHermesHome(home, () => {
      expect(readNousAuthSession()).toEqual({ status: 'missing' })
    })
    rmSync(home, { recursive: true, force: true })
  })

  it('returns missing when the nous block has no access token (logged out)', () => {
    const home = mkdtempSync(join(tmpdir(), 'nous-auth-test-'))
    writeAuthFile(home, { providers: { nous: { refresh_token: 'rt' } } })
    withHermesHome(home, () => {
      expect(readNousAuthSession()).toEqual({ status: 'missing' })
    })
    rmSync(home, { recursive: true, force: true })
  })

  it('parses the nous session with defaults for absent portal/client fields', () => {
    const home = mkdtempSync(join(tmpdir(), 'nous-auth-test-'))
    writeAuthFile(home, {
      providers: {
        nous: {
          access_token: 'at',
          refresh_token: 'rt',
          expires_at: '2026-08-17T12:00:00+00:00'
        }
      }
    })
    withHermesHome(home, () => {
      const result = readNousAuthSession()
      expect(result).toEqual({
        status: 'ok',
        session: {
          accessToken: 'at',
          refreshToken: 'rt',
          clientId: 'hermes-cli',
          portalBaseUrl: 'https://portal.nousresearch.com',
          expiresAtMs: Date.parse('2026-08-17T12:00:00+00:00')
        }
      })
    })
    rmSync(home, { recursive: true, force: true })
  })

  it('keeps the stored portal base URL and client id', () => {
    const home = mkdtempSync(join(tmpdir(), 'nous-auth-test-'))
    writeAuthFile(home, {
      providers: {
        nous: {
          access_token: 'at',
          client_id: 'hermes-cli',
          portal_base_url: 'https://portal.nousresearch.com/'
        }
      }
    })
    withHermesHome(home, () => {
      const result = readNousAuthSession()
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.session.portalBaseUrl).toBe('https://portal.nousresearch.com/')
      }
    })
    rmSync(home, { recursive: true, force: true })
  })

  it.each([
    ['https://evil.example'],
    ['http://portal.nousresearch.com'],
    ['https://user:pass@portal.nousresearch.com'],
    ['https://portal.nousresearch.com:8443'],
    ['https://portal.nousresearch.com.evil.example'],
    ['not a url']
  ])('fails closed on an untrusted portal base URL (%s)', (portalBaseUrl) => {
    const home = mkdtempSync(join(tmpdir(), 'nous-auth-test-'))
    writeAuthFile(home, {
      providers: {
        nous: {
          access_token: 'at',
          refresh_token: 'rt',
          portal_base_url: portalBaseUrl
        }
      }
    })
    withHermesHome(home, () => {
      const result = readNousAuthSession()
      expect(result.status).toBe('error')
    })
    rmSync(home, { recursive: true, force: true })
  })
})

describe('getHermesHome', () => {
  it('honors a HERMES_HOME override on any platform', () => {
    expect(
      getHermesHome({
        env: { HERMES_HOME: join('/srv', 'hermes') },
        platform: 'win32',
        homeDir: join('/users', 'alice')
      })
    ).toBe(join('/srv', 'hermes'))
  })

  it('defaults to %LOCALAPPDATA%\\hermes on Windows', () => {
    expect(
      getHermesHome({
        env: { LOCALAPPDATA: join('/local') },
        platform: 'win32',
        homeDir: join('/users', 'alice'),
        directoryExists: (candidate) => candidate === join('/local', 'hermes')
      })
    ).toBe(join('/local', 'hermes'))
  })

  it('defaults to ~/.hermes on POSIX', () => {
    expect(
      getHermesHome({
        env: {},
        platform: 'linux',
        homeDir: join('/users', 'alice')
      })
    ).toBe(join('/users', 'alice', '.hermes'))
  })
})
