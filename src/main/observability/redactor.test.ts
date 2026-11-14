import { describe, it, expect } from 'vitest'
import { redactString, redactValue } from './redactor'

describe('redactor — labeled key-value', () => {
  it.each([
    {
      name: 'compound OAuth names and ordinary quoted escapes',
      text: String.raw`{"refresh_token":"synthetic-refresh","accessToken":"synthetic-access","client_secret":"synthetic-client","token":"synthetic-token\"private-suffix","max_tokens":42,"token_count":3,"tokenCount":4,"cause":"harness unavailable"}`,
      secrets: ['synthetic-refresh', 'synthetic-access', 'synthetic-client', 'private-suffix'],
      keep: ['"max_tokens":42', '"token_count":3', '"tokenCount":4', 'harness unavailable']
    },
    {
      name: 'one serialization layer of quoted labels and values',
      text: String.raw`body: {\"token\":\"synthetic-token\\\"private-suffix\",\"refresh_token\":\"synthetic-escaped\"} harness unavailable`,
      secrets: ['synthetic-token', 'private-suffix', 'synthetic-escaped'],
      keep: ['body:', 'harness unavailable']
    },
    {
      name: 'unterminated quoted values',
      text: 'refresh_token="synthetic with private spaces\nharness unavailable tokenCount=4',
      secrets: ['synthetic', 'private spaces'],
      keep: ['harness unavailable tokenCount=4']
    },
    {
      name: 'complete authorization schemes and standalone Bearer',
      text: 'denied Authorization: Basic c3ludGhldGlj next Authorization=Token synthetic-token next Bearer opaque~+/=; harness unavailable; token expired',
      secrets: ['c3ludGhldGlj', 'synthetic-token', 'opaque~+/='],
      keep: ['denied', 'harness unavailable', 'token expired']
    }
  ])('redacts $name without losing evidence', ({ text, secrets, keep }) => {
    const out = redactString(text)
    for (const secret of secrets) {
      expect(out).not.toContain(secret)
    }
    for (const evidence of keep) {
      expect(out).toContain(evidence)
    }
  })
})

describe('redactor — complete credential spans', () => {
  it.each([
    {
      name: 'unquoted, bare and adjacent complete private keys',
      text: 'private_key: -----BEGIN PRIVATE KEY-----\nsynthetic-private-body\n-----END PRIVATE KEY-----\nbetween evidence\nsecret: -----BEGIN RSA PRIVATE KEY-----\nsynthetic-bare-body\n-----END RSA PRIVATE KEY-----\n-----BEGIN PRIVATE KEY-----\nsynthetic-unlabelled-body\n-----END PRIVATE KEY-----\nharness evidence',
      secrets: ['synthetic-private-body', 'synthetic-bare-body', 'synthetic-unlabelled-body'],
      keep: ['between evidence', 'harness evidence']
    },
    {
      name: 'Node inspect concatenation',
      text: String.raw`{ secretKey: '-----BEGIN PRIVATE KEY-----\n' +
  'synthetic-inspect-body\n' +
  '-----END PRIVATE KEY-----\n', cause: 'harness evidence' }`,
      secrets: ['synthetic-inspect-body'],
      keep: ['harness evidence']
    },
    {
      name: 'a quoted key with actual line breaks',
      text: '{"privateKey":"-----BEGIN RSA PRIVATE KEY-----\nsynthetic-quoted-body\n-----END RSA PRIVATE KEY-----","cause":"harness evidence"}',
      secrets: ['synthetic-quoted-body'],
      keep: ['harness evidence']
    },
    {
      name: 'an AWS secret nested in an outer assignment',
      text: 'harness evidence token: aws_secret_access_key=\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA next evidence',
      secrets: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      keep: ['harness evidence', 'next evidence']
    }
  ])('removes $name without losing surrounding evidence', ({ text, secrets, keep }) => {
    const out = redactString(text)
    for (const secret of secrets) {
      expect(out).not.toContain(secret)
    }
    for (const evidence of keep) {
      expect(out).toContain(evidence)
    }
  })

  it('removes an unfinished private key through the actual input end', () => {
    const out = redactString(
      'harness evidence private_key: -----BEGIN PRIVATE KEY-----\nsynthetic-unfinished-body\nsynthetic-final-line\n'
    )
    expect(out).toBe('harness evidence private_key: [redacted:labeled-kv]')
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
})
