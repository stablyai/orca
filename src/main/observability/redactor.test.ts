// Fixture-based test suite for the redactor. Each provider-key shape is
// exercised in three locations (attribute value, span event message,
// exit-status `cause`) — that's the contract telemetry-error-tracking.md
// §The redactor "Test strategy" calls for. We also cover the four other
// rule families (labeled kv, URL userinfo, .env-line, attribute blocklist)
// plus the server-side mode that drops install_id.

import { describe, it, expect } from 'vitest'
import {
  redactString,
  redactAttributes,
  redactValue,
  redactSpan,
  type RedactableSpan
} from './redactor'

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

const SHAPES: { label: string; raw: string; tag: string }[] = [
  { label: 'anthropic', raw: SECRETS.anthropic, tag: 'anthropic-key' },
  { label: 'openai', raw: SECRETS.openai, tag: 'openai-key' },
  { label: 'github', raw: SECRETS.github, tag: 'github-token' },
  { label: 'aws-access-key', raw: SECRETS.awsAccessKey, tag: 'aws-access-key-id' },
  { label: 'aws-secret', raw: SECRETS.awsSecret, tag: 'aws-secret-access-key' },
  { label: 'jwt', raw: SECRETS.jwt, tag: 'jwt' },
  { label: 'slack', raw: SECRETS.slack, tag: 'slack-token' },
  { label: 'pem', raw: SECRETS.pem, tag: 'pem' }
]

describe('redactor — provider-key fingerprints', () => {
  for (const { label, raw, tag } of SHAPES) {
    describe(`${label}`, () => {
      it('redacts when the secret appears as an attribute value', () => {
        // Bare "<secret>" without a labeled-kv keyword nearby — exercises the
        // provider-shape pass directly. (The labeled-kv pass is verified by
        // its own test below; here we want to confirm provider-shape wins
        // when there's no label to swallow it.)
        const out = redactAttributes({ msg: `failure ${raw}` })
        const serialized = JSON.stringify(out)
        expect(serialized).not.toContain(raw)
        expect(serialized).toContain(`[redacted:${tag}]`)
      })

      it('redacts when the secret appears in a span event attribute', () => {
        const span = makeSpan({
          events: [
            {
              name: 'log',
              timeUnixNano: '0',
              attributes: { 'log.message': `oops ${raw}` }
            }
          ]
        })
        const out = JSON.stringify(redactSpan(span))
        expect(out).not.toContain(raw)
        expect(out).toContain(`[redacted:${tag}]`)
      })

      it('redacts when the secret appears in the exit cause', () => {
        const span = makeSpan({
          exit: {
            _tag: 'Failure',
            // Phrased without a labeled-kv keyword (no "token:", "key:") so
            // the assertion can pin the provider-specific tag — the labeled-
            // kv rule is checked separately. What matters most is that the
            // raw secret is absent; the tag is for triage convenience.
            cause: `Error: provider rejected request ${raw}\n  at handler (file.ts:1:1)`
          }
        })
        const out = JSON.stringify(redactSpan(span))
        expect(out).not.toContain(raw)
        expect(out).toContain(`[redacted:${tag}]`)
      })

      it('redacts when nested under a labeled-kv keyword (defense in depth)', () => {
        // This case mimics the real-world failure mode: the provider SDK
        // echoes the key back as `Invalid token: sk-ant-…`. Either the
        // labeled-kv or provider-shape rule is allowed to win; the contract
        // is "the secret is gone."
        const span = makeSpan({
          exit: {
            _tag: 'Failure',
            cause: `Invalid token: ${raw}`
          }
        })
        const out = JSON.stringify(redactSpan(span))
        expect(out).not.toContain(raw)
      })
    })
  }
})

describe('redactor — labeled key-value', () => {
  it('redacts api_key:', () => {
    expect(redactString('api_key: hunter2')).toBe('[redacted:labeled-kv]')
  })
  it('redacts Authorization=Bearer …', () => {
    expect(redactString('Authorization=Bearer abcdef')).toBe('[redacted:labeled-kv]')
  })
  it('redacts password=…', () => {
    expect(redactString("password='hunter2'")).toContain('[redacted:labeled-kv]')
  })
  it('redacts secret=…', () => {
    expect(redactString('secret=topsekret')).toBe('[redacted:labeled-kv]')
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
  it('preserves bare URLs without userinfo', () => {
    expect(redactString('https://github.com/foo')).toBe('https://github.com/foo')
  })
})

describe('redactor — .env-shape line', () => {
  it('redacts the value but keeps the key', () => {
    const out = redactString('FOO_SECRET=topsekret')
    expect(out).toContain('FOO_SECRET=')
    expect(out).toContain('[redacted:env-value]')
    expect(out).not.toContain('topsekret')
  })
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
  it('drops env attribute', () => {
    const out = redactAttributes({ env: { ANTHROPIC_API_KEY: SECRETS.anthropic } })
    expect(out).not.toHaveProperty('env')
  })
  it('drops authorization (case-insensitive)', () => {
    const out = redactAttributes({ Authorization: 'Bearer x', cookie: 'a=b' })
    expect(out).not.toHaveProperty('Authorization')
    expect(out).not.toHaveProperty('cookie')
  })
  it('drops headers.authorization', () => {
    const out = redactAttributes({ 'headers.authorization': 'Bearer x' })
    expect(out).not.toHaveProperty('headers.authorization')
  })
  it('drops structured secret-bearing keys with plain values', () => {
    const out = redactAttributes({
      token: 'plain-token',
      api_key: 'plain-api-key',
      password: 'plain-password',
      secret: 'plain-secret',
      keep: 'ok'
    })
    expect(out).not.toHaveProperty('token')
    expect(out).not.toHaveProperty('api_key')
    expect(out).not.toHaveProperty('password')
    expect(out).not.toHaveProperty('secret')
    expect(out.keep).toBe('ok')
  })
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
  it('keeps non-blocklisted keys', () => {
    const out = redactAttributes({ path: '/Users/x/repo', method: 'GET' })
    expect(out).toHaveProperty('path')
    expect(out).toHaveProperty('method')
  })
  it('preserves filesystem paths verbatim — they are diagnostic data', () => {
    const out = redactAttributes({ cwd: '/Users/brennanb/projects/orca' })
    expect(out.cwd).toBe('/Users/brennanb/projects/orca')
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
  it('drops install_id, installId, distinct_id', () => {
    const before = {
      install_id: 'abc',
      installId: 'def',
      distinct_id: 'ghi',
      keep: 'me'
    }
    const client = redactAttributes(before, 'client')
    const server = redactAttributes(before, 'server')

    // Client mode keeps these (they are valid in product telemetry).
    expect(client).toHaveProperty('install_id')
    expect(client).toHaveProperty('installId')
    expect(client).toHaveProperty('distinct_id')

    // Server mode strips them.
    expect(server).not.toHaveProperty('install_id')
    expect(server).not.toHaveProperty('installId')
    expect(server).not.toHaveProperty('distinct_id')
    expect(server).toHaveProperty('keep')
  })
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
  it('handles circular references without crashing', () => {
    const a: Record<string, unknown> = {}
    a.self = a
    expect(() => redactValue(a)).not.toThrow()
  })
})

describe('redactor — idempotence', () => {
  it('running twice equals running once', () => {
    const cases = [
      `api_key: ${SECRETS.anthropic}`,
      `https://${SECRETS.github}@github.com/foo`,
      'FOO=bar',
      'plain text'
    ]
    for (const c of cases) {
      const once = redactString(c)
      const twice = redactString(once)
      expect(twice).toBe(once)
    }
  })
})

describe('redactor — span shape', () => {
  it('preserves traceId/spanId/name/duration', () => {
    const span = makeSpan({})
    const out = redactSpan(span)
    expect(out.traceId).toBe(span.traceId)
    expect(out.spanId).toBe(span.spanId)
    expect(out.name).toBe(span.name)
    expect(out.durationMs).toBe(span.durationMs)
  })
  it('preserves parentSpanId when present', () => {
    const span = makeSpan({ parentSpanId: 'parent123' })
    expect(redactSpan(span).parentSpanId).toBe('parent123')
  })
  it('does not mutate input span', () => {
    const before = makeSpan({
      attributes: { token: SECRETS.anthropic }
    })
    const beforeStr = JSON.stringify(before)
    redactSpan(before)
    expect(JSON.stringify(before)).toBe(beforeStr)
  })
})

// ── helpers ──────────────────────────────────────────────────────────────

function makeSpan(overrides: Partial<RedactableSpan>): RedactableSpan {
  return {
    name: 'test.span',
    traceId: '00000000000000000000000000000001',
    spanId: '0000000000000001',
    kind: 'internal',
    startTimeUnixNano: '1000',
    endTimeUnixNano: '2000',
    durationMs: 1.0,
    attributes: {},
    events: [],
    exit: { _tag: 'Success' },
    ...overrides
  }
}
