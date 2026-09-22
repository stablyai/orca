import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeAntigravitySecret,
  hasAntigravityAuthFile,
  readAntigravityAuthSession
} from './antigravity-oauth-sources'

function encodeGoKeyring(payload: unknown): string {
  return `go-keyring-base64:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`
}

describe('antigravity-oauth-sources', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('decodes go-keyring-base64 secrets', () => {
    const session = decodeAntigravitySecret(
      encodeGoKeyring({
        token: {
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expiry: '2026-09-21T12:00:00.000Z'
        }
      })
    )
    expect(session).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh',
      expiresAtMs: Date.parse('2026-09-21T12:00:00.000Z'),
      email: null
    })
  })

  it('reads the on-disk Antigravity CLI token file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-agy-home-'))
    dirs.push(home)
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const dir = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'antigravity-oauth-token'),
      JSON.stringify({
        token: { access_token: 'ya29.file', refresh_token: '1//file' }
      })
    )

    expect(hasAntigravityAuthFile(home)).toBe(true)
    await expect(readAntigravityAuthSession(home)).resolves.toEqual({
      status: 'ok',
      session: {
        accessToken: 'ya29.file',
        refreshToken: '1//file',
        expiresAtMs: null,
        email: null
      }
    })
  })

  it('returns missing when no token file or keychain item exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-agy-missing-'))
    dirs.push(home)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(readAntigravityAuthSession(home)).resolves.toEqual({ status: 'missing' })
  })
})
