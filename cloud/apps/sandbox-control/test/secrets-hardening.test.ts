// SEC-6: (a) a demoted admin can't write team secrets with an old token, and admin writes need a token
// under a minute old; (b) last-4 hints are shown only to people who can write the scope; (c) secret
// handling code logs through secretLog, which redacts, and no planted value reaches the log sink.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_IAT_BACKDATE_MS, recordMemberChange } from '../src/member-changes'
import { ADMIN_WRITE_TOKEN_MAX_AGE_MS } from '../src/secrets'
import { redactLine, secretLog, setSecretLogSink } from '../src/secret-log'
import { createHarness } from './harness'

const KEK = Buffer.alloc(32, 7).toString('base64')
// Fake values only.
const TEAM_KEY = 'sk-ant-api03-HARDENING-fake-0000-aaaa'
const PLAIN_VALUE = 'unshaped-database-password-0042'

let sink: string[] = []
let consoleLines: string[] = []
let restoreSink: () => void = () => {}
beforeEach(() => {
  sink = []
  consoleLines = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
  restoreSink = setSecretLogSink((line) => sink.push(line))
})
afterEach(() => {
  restoreSink()
  for (const value of [TEAM_KEY, PLAIN_VALUE]) {
    expect([...sink, ...consoleLines].join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

async function setup() {
  const h = await createHarness({ SECRETS_KEK: KEK })
  const put = (scope: string, name: string, value: string, bearer: string, repo?: string) =>
    h.call('PUT', `/v1/secrets/${scope}/${name}${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`, { body: { value }, bearer })
  const rows = () => h.raw.prepare('SELECT scope, owner_id, name, updated_at FROM secrets ORDER BY name').all()
  return { h, put, rows }
}

describe('SEC-6a: role changes reach secret writes within a minute', () => {
  it('a demoted admin’s earlier token can’t put, delete or batch team secrets once auth reports the change', async () => {
    const { h, put, rows } = await setup()
    const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
    expect((await put('org', 'TEAM_KEY', TEAM_KEY, admin)).status).toBe(200)
    const before = rows()
    h.advance(AUTH_IAT_BACKDATE_MS + 1_000)
    await recordMemberChange(h.env.SANDBOX_DB, 'org:acme', 'ada', 'role', h.now())
    const attempts = [
      await put('org', 'TEAM_KEY', 'replacement-value-123', admin),
      await put('repo', 'DATABASE_URL', PLAIN_VALUE, admin, 'acme/web'),
      await h.call('DELETE', '/v1/secrets/org/TEAM_KEY', { bearer: admin }),
      await h.call('POST', '/v1/secrets/org/batch', { bearer: admin, body: { delete: ['TEAM_KEY'] } })
    ]
    for (const res of attempts) {
      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ reason: 'stale_token' })
    }
    expect(rows()).toEqual(before)
    // The re-minted token carries the new role and is refused for its role, not its age.
    h.advance(1_000)
    const member = await h.token('ada', 'acme', 'sandbox', { org_role: 'member' })
    expect((await put('org', 'TEAM_KEY', 'replacement-value-123', member)).body).toMatchObject({ reason: 'org_admin_required' })
  })

  it('without the push, an admin write needs a token minted in the last minute; reads and personal writes don’t', async () => {
    const { h, put } = await setup()
    const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
    h.advance(ADMIN_WRITE_TOKEN_MAX_AGE_MS - 1_000)
    expect((await put('org', 'TEAM_KEY', TEAM_KEY, admin)).status).toBe(200)
    h.advance(2_000)
    for (const res of [
      await put('org', 'TEAM_KEY', TEAM_KEY, admin),
      await put('repo', 'DATABASE_URL', PLAIN_VALUE, admin, 'acme/web'),
      await h.call('DELETE', '/v1/secrets/org/TEAM_KEY', { bearer: admin }),
      await h.call('POST', '/v1/secrets/repo/batch?repo=acme/web', { bearer: admin, body: { set: { A: PLAIN_VALUE } } })
    ]) {
      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: 'unauthorized', reason: 'stale_token' })
    }
    expect((await h.call('GET', '/v1/secrets?scope=org', { bearer: admin })).status).toBe(200)
    expect((await put('personal', 'MY_VAR', PLAIN_VALUE, admin)).status).toBe(200)
    // A personal account's repository secrets have no role to lose.
    const solo = await h.token('carol')
    h.advance(4 * 60_000)
    expect((await put('repo', 'DATABASE_URL', PLAIN_VALUE, solo, 'carol/app')).status).toBe(200)
    // A fresh admin token writes again.
    const fresh = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
    expect((await put('org', 'TEAM_KEY', TEAM_KEY, fresh)).status).toBe(200)
  })
})

describe('SEC-6b: last-4 hints only for people who can write the scope', () => {
  it('team members get no hints for Shared or team Repository secrets; admins and owners of personal ones do', async () => {
    const { h, put } = await setup()
    const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
    const member = await h.token('mia', 'acme', 'sandbox', { org_role: 'member' })
    await put('org', 'TEAM_KEY', TEAM_KEY, admin)
    await put('repo', 'DATABASE_URL', PLAIN_VALUE, admin, 'acme/web')
    await put('personal', 'MY_VAR', PLAIN_VALUE, member)
    const list = async (bearer: string, query: string) =>
      (await h.call('GET', `/v1/secrets?${query}`, { bearer })).body.secrets.map((s: any) => s.hint)
    expect(await list(admin, 'scope=org')).toEqual(['aaaa'])
    expect(await list(member, 'scope=org')).toEqual([null])
    expect(await list(admin, 'scope=repo&repo=acme/web')).toEqual(['0042'])
    expect(await list(member, 'scope=repo&repo=acme/web')).toEqual([null])
    expect(await list(member, 'scope=personal')).toEqual(['0042'])
    const effective = (await h.call('GET', '/v1/secrets/effective?repo=acme/web', { bearer: member })).body.secrets
    expect(effective.map((s: any) => [s.name, s.hint])).toEqual([
      ['DATABASE_URL', null],
      ['MY_VAR', '0042'],
      ['TEAM_KEY', null]
    ])
  })
})

describe('SEC-6c: secret-handling code logs only through the redacting sink', () => {
  const FILES = ['secrets.ts', 'session-env.ts', 'env-refresh.ts', 'egress-proxy.ts', 'secret-egress.ts', 'secrets-crypto.ts', 'secret-events.ts']

  it('the secret-handling modules never call console directly', () => {
    for (const file of FILES) {
      const source = readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
      expect({ file, direct: /\bconsole\s*\.\s*[a-z]+\s*\(/.test(source) }).toEqual({ file, direct: false })
    }
  })

  it('redacts values passed as known, in raw and JSON-escaped form, and credential shapes', () => {
    const quoted = 'pa"ss\\word-with-quotes-99'
    secretLog('probe', { error: new Error(`upstream said ${PLAIN_VALUE}`), body: { echoed: quoted } }, [PLAIN_VALUE, quoted])
    secretLog('probe', {
      message: `bad key ${TEAM_KEY}; auth=Bearer abcdefghijklmnop.qrstuvwx; gh=ghp_${'a'.repeat(36)}; aws=AKIAABCDEFGHIJKLMNOP`
    })
    const text = sink.join('\n')
    expect(text).not.toContain(PLAIN_VALUE)
    expect(text).not.toContain('ss\\\\word-with-quotes')
    expect(text).not.toContain(TEAM_KEY)
    expect(text).not.toContain('abcdefghijklmnop')
    expect(text).not.toContain('ghp_aaaa')
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP')
    expect(text).toContain('Bearer [redacted]')
    // Names, ids and counts survive.
    expect(redactLine('{"event":"secret_written","name":"ANTHROPIC_API_KEY","sandboxId":"sbx_123","count":4}')).toBe(
      '{"event":"secret_written","name":"ANTHROPIC_API_KEY","sandboxId":"sbx_123","count":4}'
    )
    // Errors never carry their stack.
    expect(text).not.toContain('at ')
  })

  it('a full write, batch and session start leave no planted value in the sink', async () => {
    const { h, put } = await setup()
    const admin = await h.token('ada', 'acme', 'sandbox', { org_role: 'admin' })
    await put('org', 'ANTHROPIC_API_KEY', TEAM_KEY, admin)
    await h.call('POST', '/v1/secrets/org/batch', { bearer: admin, body: { set: { DB_PASSWORD: PLAIN_VALUE } } })
    const created = await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: admin })
    expect(created.status).toBe(200)
    expect(sink.some((line) => line.includes('secrets_batch'))).toBe(true)
    expect(sink.some((line) => line.includes('session_secrets'))).toBe(true)
    // afterEach checks the sink and console for every planted value.
  })
})
