import { describe, expect, it } from 'vitest'
import { readNousAuthSession } from './nous-auth'
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
          portal_base_url: 'https://preview.nousresearch.com/'
        }
      }
    })
    withHermesHome(home, () => {
      const result = readNousAuthSession()
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(result.session.portalBaseUrl).toBe('https://preview.nousresearch.com/')
      }
    })
    rmSync(home, { recursive: true, force: true })
  })
})
