import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseAntigravityCredentialBlob,
  readAntigravityCredentials
} from './antigravity-credentials'

describe('parseAntigravityCredentialBlob', () => {
  it('parses Antigravity 4.x credential JSON', () => {
    const creds = parseAntigravityCredentialBlob(
      JSON.stringify({
        token: {
          access_token: 'ya29.access',
          refresh_token: '1//refresh',
          expiry: '2026-07-18T12:00:00Z'
        },
        auth_method: 'oauth'
      })
    )
    expect(creds).toEqual({
      accessToken: 'ya29.access',
      refreshToken: '1//refresh'
    })
  })

  it('rejects invalid blobs', () => {
    expect(parseAntigravityCredentialBlob('not-json')).toBeNull()
    expect(parseAntigravityCredentialBlob('{}')).toBeNull()
  })

  it('accepts a current access token when no refresh token is stored', () => {
    expect(
      parseAntigravityCredentialBlob(JSON.stringify({ token: { access_token: 'x' } }))
    ).toEqual({ accessToken: 'x', refreshToken: null })
  })
})

describe('readAntigravityCredentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns unsupported off Windows', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      await expect(readAntigravityCredentials()).resolves.toEqual({ status: 'unsupported' })
    } finally {
      Object.defineProperty(process, 'platform', { value: original })
    }
  })

  it('honors cancellation before platform probing', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(readAntigravityCredentials(controller.signal)).rejects.toThrow('stopped')
  })
})
