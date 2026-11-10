import { describe, expect, it } from 'vitest'
import { createHarness } from './harness'

const OP = 'o'.repeat(40)

async function harness() {
  const pending: Promise<unknown>[] = []
  const h = await createHarness({ PUBLIC_API_URL: 'https://api.test', OPERATOR_TOKEN: OP }, { waitUntil: (p) => void pending.push(p) })
  return { ...h, settle: () => Promise.all(pending.splice(0)) }
}

describe('member role changes cap keys and MCP grants', () => {
  it('drops admin-only scopes from a demoted admin key, via the auth route and via their own next request', async () => {
    const h = await harness()
    const asAdmin = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
    const { secret } = (await h.call('POST', '/v1/api-keys', { bearer: asAdmin, body: { name: 'audit', scopes: ['audit:read', 'workspaces:read'] } })).body
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(200)

    // Auth tells us about the demotion.
    const changed = await h.call('POST', '/v1/internal/members/role-changed', { bearer: OP, body: { accountId: 'org:acme', userId: 'ada', role: 'member' } })
    expect(changed.body).toEqual({ updated: 1 })
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(403)
    expect((await h.call('GET', '/v1/me', { bearer: secret })).body.scopes).toEqual(['workspaces:read'])

    // Re-promoted: a signed-in request with the live role re-syncs it (self-heal without the auth call).
    // Its token is newer than the role-changed push; an older one could carry the pre-push role.
    h.advance(1_000)
    const promoted = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
    await h.call('GET', '/v1/me', { bearer: promoted })
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(200)
    h.advance(61_000)
    const demoted = await h.token('ada', 'acme', 'sandbox', { orgRole: 'member' })
    await h.call('GET', '/v1/me', { bearer: demoted })
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(403)
  })
})

describe('Idempotency-Key on workspace create', () => {
  it('replays the first response for a retry, refuses a reused key with a different body, and scopes keys per member', async () => {
    const h = await harness()
    const send = async (body: unknown, key: string, as = 'alice') =>
      h.send(new Request('https://sandbox.test/v1/workspaces', {
        method: 'POST',
        headers: { authorization: `Bearer ${await h.token(as)}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body)
      }))
    const first = await send({ name: 'once' }, 'retry-key-0001')
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { workspace: { id: string } }
    const retry = await send({ name: 'once' }, 'retry-key-0001')
    expect(retry.status).toBe(201)
    expect(retry.headers.get('idempotent-replayed')).toBe('true')
    expect(((await retry.json()) as { workspace: { id: string } }).workspace.id).toBe(firstBody.workspace.id)
    expect(h.vercel.boxes.size).toBe(1)
    expect((await send({ name: 'different' }, 'retry-key-0001')).status).toBe(422)
    // Expires after 24h: the same key creates again.
    h.advance(24 * 60 * 60_000 + 1)
    expect((await send({ name: 'once' }, 'retry-key-0001')).headers.get('idempotent-replayed')).toBeNull()
    expect((await send({ name: 'x' }, 'bad key!')).status).toBe(400)
  })

  it('releases the key when the create fails so a retry really runs', async () => {
    const h = await harness()
    h.vercel.failCreate = true
    const req = async () =>
      h.send(new Request('https://sandbox.test/v1/workspaces', {
        method: 'POST',
        headers: { authorization: `Bearer ${await h.token('alice')}`, 'content-type': 'application/json', 'idempotency-key': 'fail-then-ok' },
        body: '{}'
      }))
    expect((await req()).status).toBeGreaterThanOrEqual(500)
    h.vercel.failCreate = false
    const ok = await req()
    expect(ok.status).toBe(201)
    expect(ok.headers.get('idempotent-replayed')).toBeNull()
  })
})

describe('teammate names', () => {
  it('labels keys, audit entries and messages with the member name from their token, and names the sender to the agent', async () => {
    const h = await harness()
    try {
      h.raw.exec("ALTER TABLE sandboxes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'")
    } catch {
      // present once W4's migration is in the test schema
    }
    const ada = await h.token('ada', 'acme', 'sandbox', { orgRole: 'owner', name: 'Ada Lovelace' })
    const bob = await h.token('bob', 'acme', 'sandbox', { orgRole: 'member', name: 'Bob Byte' })
    await h.call('POST', '/v1/api-keys', { bearer: bob, body: { name: 'bob ci', scopes: ['workspaces:read'] } })
    const keys = (await h.call('GET', '/v1/api-keys', { bearer: ada })).body.keys
    expect(keys[0]).toMatchObject({ createdBy: 'bob', createdByName: 'Bob Byte' })
    const audit = (await h.call('GET', '/v1/audit', { bearer: ada })).body.entries
    expect(audit[0].actor).toMatchObject({ userId: 'bob', userName: 'Bob Byte' })

    const ws = (await h.call('POST', '/v1/workspaces', { bearer: ada, body: {} })).body.workspace
    h.raw.prepare("UPDATE sandboxes SET visibility = 'team' WHERE id = ?").run(ws.id)
    h.vercel.commandHandler = (params) =>
      params.args?.includes('agent') ? { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: 'term_n1' } } }), stderr: '' } : undefined
    await h.call('POST', `/v1/workspaces/${ws.id}/messages`, { bearer: bob, body: { text: 'hello' } })
    await h.settle()
    const launch = h.vercel.commands.filter((c) => c.args?.includes('agent')).at(-1)!
    expect(launch.args!.at(-1)).toBe('--prompt=[orca-sender name="Bob Byte" id="bob"]\nhello')
    const messages = (await h.call('GET', `/v1/workspaces/${ws.id}/messages`, { bearer: ada })).body.messages
    expect(messages[0]).toMatchObject({ sentBy: 'bob', sentByName: 'Bob Byte' })
  })
})

describe('workspace create with a team environment', () => {
  it('rejects an unknown environment before booting anything, and a malformed id as invalid', async () => {
    const h = await harness()
    const missing = await h.call('POST', '/v1/workspaces', { body: { environment: 'env_missing01' } })
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'not_found', reason: 'environment' })
    expect((await h.call('POST', '/v1/workspaces', { body: { environment: 'prod' } })).status).toBe(400)
    expect(h.vercel.boxes.size).toBe(0)
  })
})
