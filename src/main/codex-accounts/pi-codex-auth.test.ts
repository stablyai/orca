import { describe, expect, it, vi } from 'vitest'
import { readCodexAuthIdentity } from './codex-auth-identity'
import {
  createCodexAuthJsonFromPiCredential,
  getPiCodexCredential,
  parsePiCodexBearerToken
} from './pi-codex-auth'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

const identityClaims = {
  email: 'user@example.com',
  exp: Math.floor(Date.now() / 1_000) + 3_600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' }
}

describe('Pi Codex auth', () => {
  it('reads identity from the bearer token returned by Pi', async () => {
    const accessToken = jwt(identityClaims)
    const run = vi.fn().mockResolvedValue({
      code: 0,
      signal: null,
      stdout: `${accessToken}\n`,
      stderr: '',
      timedOut: false
    })

    await expect(
      getPiCodexCredential(undefined, { resolveCommand: () => '/usr/local/bin/pi', run })
    ).resolves.toEqual({
      accessToken,
      providerAccountId: 'account-123',
      email: 'user@example.com'
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/local/bin/pi',
        args: ['auth', 'print-bearer-token', '--provider', 'openai-codex'],
        timeoutMs: 15_000
      })
    )
  })

  it('creates Codex-shaped auth that preserves the Pi account identity', () => {
    const accessToken = jwt(identityClaims)
    expect(
      readCodexAuthIdentity(
        createCodexAuthJsonFromPiCredential({
          accessToken,
          providerAccountId: 'account-123',
          email: 'user@example.com'
        })
      )
    ).toMatchObject({ email: 'user@example.com', providerAccountId: 'account-123' })
  })

  it('rejects malformed and expired credentials', () => {
    expect(() => parsePiCodexBearerToken('not-a-jwt')).toThrow(/without account identity/)
    expect(() =>
      parsePiCodexBearerToken(jwt({ ...identityClaims, exp: Math.floor(Date.now() / 1_000) - 1 }))
    ).toThrow(/expired/)
  })

  it('reports a missing or signed-out Pi CLI without exposing command output', async () => {
    await expect(
      getPiCodexCredential(undefined, {
        resolveCommand: () => 'pi',
        run: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('spawn pi ENOENT'), { code: 'ENOENT' }))
      })
    ).rejects.toThrow(/Pi CLI was not found/)

    await expect(
      getPiCodexCredential(undefined, {
        resolveCommand: () => 'pi',
        run: vi.fn().mockResolvedValue({
          code: 1,
          signal: null,
          stdout: '',
          stderr: 'secret provider diagnostic',
          timedOut: false
        })
      })
    ).rejects.toThrow(/no usable OpenAI Codex login/)
  })
})
