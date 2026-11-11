import { describe, it, expect } from 'vitest'
import { redactString, redactValue } from './redactor'

const SECRETS = {
  anthropic: 'sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ABCDEFGHIJKLMNOP',
  openai: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGH',
  github: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AB',
  awsAccessKey: 'AKIAIOSFODNN7EXAMPLE',
  awsSecret: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  slack: 'xoxb-1234567890-abcdefghij',
  pem: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----'
}

describe('redactor — labeled key-value', () => {
  it('redacts api_key:', () => {
    expect(redactString('api_key: hunter2')).toBe('[redacted:labeled-kv]')
  })
  it('redacts Authorization=Bearer …', () => {
    expect(redactString('Authorization=Bearer abcdef')).toBe('[redacted:labeled-kv]')
  })

  it('preserves surrounding context outside the matched segment', () => {
    const out = redactString('before api_key=xyz after')
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).not.toContain('xyz')
  })
})

describe('redactor — URL userinfo strip', () => {
  it('strips user:pass@ from https URLs', () => {
    const out = redactString('clone failed: https://ghp_xxxxxxxxxx@github.com/foo/bar')
    expect(out).not.toContain('ghp_xxxxxxxxxx@')
    expect(out).toContain('github.com/foo/bar')
    expect(out).toContain('[redacted]@')
  })
})

describe('redactor — .env-shape line', () => {
  it('handles multi-line .env dumps', () => {
    const out = redactString(['DB_HOST=db.local', 'DB_PASSWORD=hunter2', '# comment'].join('\n'))
    expect(out).toContain('DB_HOST=[redacted:env-value]')
    expect(out).toContain('DB_PASSWORD=[redacted:env-value]')
    expect(out).toContain('# comment')
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('db.local')
  })
})

describe('redactor — attribute-key blocklist', () => {
  it('drops compound structured secret-bearing keys with plain values', () => {
    const out = redactValue({
      ANTHROPIC_API_KEY: 'plain-anthropic',
      client_secret: 'plain-client',
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      'x-api-key': 'plain-x-api',
      private_key: 'plain-private',
      auth_token: 'plain-auth',
      AUTH_TOKEN: 'plain-auth-upper',
      sessionToken: 'plain-session',
      githubToken: 'plain-github',
      DB_PASSWORD: 'plain-db',
      serverSecretKey: 'plain-server',
      keep: 'ok'
    }) as Record<string, unknown>
    expect(out).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(out).not.toHaveProperty('client_secret')
    expect(out).not.toHaveProperty('accessToken')
    expect(out).not.toHaveProperty('refreshToken')
    expect(out).not.toHaveProperty('x-api-key')
    expect(out).not.toHaveProperty('private_key')
    expect(out).not.toHaveProperty('auth_token')
    expect(out).not.toHaveProperty('AUTH_TOKEN')
    expect(out).not.toHaveProperty('sessionToken')
    expect(out).not.toHaveProperty('githubToken')
    expect(out).not.toHaveProperty('DB_PASSWORD')
    expect(out).not.toHaveProperty('serverSecretKey')
    expect(out.keep).toBe('ok')
  })

  it('drops nested blocked keys while recursively redacting values', () => {
    const out = redactValue({
      request: {
        headers: {
          authorization: 'Bearer plain-secret',
          cookie: 'sid=plain-secret',
          keep: 'ok'
        }
      }
    }) as { request: { headers: Record<string, unknown> } }
    expect(out.request.headers).not.toHaveProperty('authorization')
    expect(out.request.headers).not.toHaveProperty('cookie')
    expect(out.request.headers.keep).toBe('ok')
  })
})

describe('redactor — server mode adds install_id keys', () => {
  it('drops identity keys nested inside server-mode values', () => {
    const out = redactValue({ context: { install_id: 'abc', keep: 'me' } }, 'server') as {
      context: Record<string, unknown>
    }
    expect(out.context).not.toHaveProperty('install_id')
    expect(out.context.keep).toBe('me')
  })
})

describe('redactor — recursive value redaction', () => {
  it('recurses into nested objects', () => {
    const out = redactValue({ outer: { inner: `key: ${SECRETS.anthropic}` } }) as Record<
      string,
      Record<string, string>
    >
    expect(out.outer.inner).not.toContain(SECRETS.anthropic)
    expect(out.outer.inner).toContain('[redacted:anthropic-key]')
  })
  it('recurses into arrays', () => {
    const out = redactValue([SECRETS.github, 'plain']) as string[]
    expect(out[0]).not.toContain(SECRETS.github)
    expect(out[1]).toBe('plain')
  })
})
