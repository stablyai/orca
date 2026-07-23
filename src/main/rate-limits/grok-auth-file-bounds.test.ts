import { mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_INTEGRATION_CREDENTIAL_FILE_BYTES } from '../integration-credential-file'
import { readGrokAuthSession } from './grok-auth'

const roots: string[] = []

function createGrokHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-grok-auth-bounds-'))
  roots.push(root)
  vi.stubEnv('GROK_HOME', root)
  return root
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Grok auth file bounds', () => {
  it('preserves a normal Grok auth session', () => {
    const root = createGrokHome()
    writeFileSync(
      join(root, 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::client': {
          key: 'normal-token',
          email: 'alice@example.com'
        }
      })
    )

    expect(readGrokAuthSession()).toMatchObject({
      status: 'ok',
      session: {
        accessToken: 'normal-token',
        email: 'alice@example.com'
      }
    })
  })

  it('accepts valid auth JSON at the exact credential byte limit', () => {
    const root = createGrokHome()
    const prefix = '{"https://auth.x.ai":{"key":"'
    const suffix = '"}}'
    const tokenLength = MAX_INTEGRATION_CREDENTIAL_FILE_BYTES - Buffer.byteLength(prefix + suffix)
    const authPath = join(root, 'auth.json')
    writeFileSync(authPath, `${prefix}${'x'.repeat(tokenLength)}${suffix}`)

    expect(statSync(authPath).size).toBe(MAX_INTEGRATION_CREDENTIAL_FILE_BYTES)
    const result = readGrokAuthSession()
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.session.accessToken).toHaveLength(tokenLength)
      expect(result.session.accessToken.at(0)).toBe('x')
      expect(result.session.accessToken.at(-1)).toBe('x')
    }
  })

  it('rejects an oversized sparse auth file without loading its payload', () => {
    const root = createGrokHome()
    const authPath = join(root, 'auth.json')
    writeFileSync(authPath, '')
    truncateSync(authPath, MAX_INTEGRATION_CREDENTIAL_FILE_BYTES + 1)

    expect(readGrokAuthSession()).toEqual({
      status: 'error',
      error: 'Unable to read Grok auth file'
    })
  })
})
