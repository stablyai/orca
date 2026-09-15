import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getAntigravityOAuthTokenPath,
  isAntigravityAccessTokenFresh,
  isAntigravitySessionUsable,
  readAntigravityAuthSession,
  readAntigravityDefaultProjectId,
  saveAntigravityCredentials
} from './antigravity-oauth-sources'

describe('readAntigravityAuthSession', () => {
  let home: string

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true })
    }
  })

  function writeToken(body: unknown): void {
    home = mkdtempSync(path.join(tmpdir(), 'orca-agy-auth-'))
    const dir = path.dirname(getAntigravityOAuthTokenPath(home))
    mkdirSync(dir, { recursive: true })
    writeFileSync(getAntigravityOAuthTokenPath(home), JSON.stringify(body))
  }

  it('reports missing when the token file is absent', () => {
    home = mkdtempSync(path.join(tmpdir(), 'orca-agy-auth-'))
    expect(readAntigravityAuthSession(home)).toEqual({ status: 'missing' })
  })

  it('reports missing when the token file has no credentials', () => {
    writeToken({ auth_method: 'consumer', token: {} })
    expect(readAntigravityAuthSession(home)).toEqual({ status: 'missing' })
  })

  it('reports invalid JSON without exposing the path', () => {
    writeToken(null)
    writeFileSync(getAntigravityOAuthTokenPath(home), '{')
    expect(readAntigravityAuthSession(home)).toEqual({
      status: 'error',
      error: 'Antigravity auth file is invalid'
    })
  })

  it('reads a consumer session and optional Google account email', () => {
    writeToken({
      auth_method: 'consumer',
      token: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expiry: '2099-01-01T00:00:00.000Z'
      }
    })
    mkdirSync(path.join(home, '.gemini'), { recursive: true })
    writeFileSync(
      path.join(home, '.gemini', 'google_accounts.json'),
      JSON.stringify({ active: 'dev@example.com', old: [] })
    )

    expect(readAntigravityAuthSession(home)).toEqual({
      status: 'ok',
      session: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
        authMethod: 'consumer',
        email: 'dev@example.com'
      }
    })
  })

  it('treats a refresh-only session as signed in', () => {
    writeToken({
      token: { refresh_token: 'refresh-only', expiry: '2020-01-01T00:00:00.000Z' }
    })
    const result = readAntigravityAuthSession(home)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') {
      return
    }
    expect(isAntigravityAccessTokenFresh(result.session)).toBe(false)
    expect(isAntigravitySessionUsable(result.session)).toBe(true)
  })
})

describe('saveAntigravityCredentials', () => {
  it('rewrites the token file without dropping auth_method', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orca-agy-save-'))
    try {
      mkdirSync(path.dirname(getAntigravityOAuthTokenPath(home)), { recursive: true })
      await saveAntigravityCredentials(
        {
          accessToken: 'new-access',
          refreshToken: 'refresh-1',
          expiresAtMs: Date.parse('2099-06-01T00:00:00.000Z'),
          authMethod: 'consumer',
          email: null
        },
        home
      )
      const result = readAntigravityAuthSession(home)
      expect(result).toMatchObject({
        status: 'ok',
        session: {
          accessToken: 'new-access',
          refreshToken: 'refresh-1',
          authMethod: 'consumer'
        }
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('readAntigravityDefaultProjectId', () => {
  it('returns the trimmed project id when the cache file exists', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'orca-agy-proj-'))
    try {
      const cacheDir = path.join(home, '.gemini', 'antigravity-cli', 'cache')
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(path.join(cacheDir, 'default_project_id.txt'), 'default-cli-project\n')
      await expect(readAntigravityDefaultProjectId(home)).resolves.toBe('default-cli-project')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
