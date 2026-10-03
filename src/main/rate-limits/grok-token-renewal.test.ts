import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renewGrokAuthSession } from './grok-token-renewal'

const fetch = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch } }))
let home: string
let original: string
const jwt = (id: string) =>
  `head.${Buffer.from(JSON.stringify({ sub: id, iss: 'https://auth.x.ai', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`

beforeEach(() => {
  fetch.mockReset()
  home = mkdtempSync(join(tmpdir(), 'orca-grok-renewal-test-'))
  original = JSON.stringify({
    'https://auth.x.ai::client': {
      key: 'expired',
      refresh_token: 'refresh-original',
      user_id: 'alice',
      email: 'alice@example.com',
      expires_at: '2000-01-01T00:00:00Z'
    }
  })
  writeFileSync(join(home, 'auth.json'), original)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('Grok token renewal', () => {
  it('coalesces requests for an account and saves the rotated login without exposing tokens', async () => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ access_token: jwt('alice'), refresh_token: 'refresh-new' }))
    )
    const [first, second] = await Promise.all([
      renewGrokAuthSession(home),
      renewGrokAuthSession(home)
    ])
    expect(fetch).toHaveBeenCalledOnce()
    expect(first).toMatchObject({ status: 'ok', session: { userId: 'alice' } })
    expect(second).toEqual(first)
    const saved = readFileSync(join(home, 'auth.json'), 'utf8')
    expect(saved).toContain('refresh-new')
    expect(fetch.mock.calls[0][0]).toBe('https://auth.x.ai/oauth2/token')
    expect(fetch.mock.calls[0][1].redirect).toBe('error')
  })

  it('does not overwrite a concurrent CLI logout', async () => {
    fetch.mockImplementation(async () => {
      writeFileSync(join(home, 'auth.json'), '{}')
      return new Response(JSON.stringify({ access_token: jwt('alice') }))
    })
    expect(await renewGrokAuthSession(home)).toEqual({ status: 'missing' })
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{}')
  })

  it('rejects an identity change and preserves the previous login', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify({ access_token: jwt('bob') })))
    expect(await renewGrokAuthSession(home)).toMatchObject({ status: 'error' })
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(original)
  })

  it('redacts remote failure details and leaves credentials intact', async () => {
    fetch.mockRejectedValue(new Error('refresh-original sensitive server error'))
    const result = await renewGrokAuthSession(home)
    expect(result.status).toBe('error')
    expect(JSON.stringify(result)).not.toContain('refresh-original')
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(original)
  })
})
