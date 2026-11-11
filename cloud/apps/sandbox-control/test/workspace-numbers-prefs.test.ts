import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isValidSlug, slugify } from '../src/org-slugs'
import { createHarness } from './harness'

type Role = 'owner' | 'admin' | 'member'
type Who = { sub: string; org?: string; role: Role }

async function setup() {
  const h = await createHarness()
  const req = async (who: Who, method: string, path: string, body?: unknown) =>
    h.call(method, path, { bearer: await h.token(who.sub, who.org, 'sandbox', who.org ? { org_role: who.role } : {}), body })
  let n = 0
  const create = async (who: Who, extra: Record<string, unknown> = {}) => {
    n += 1
    const res = await req(who, 'POST', '/v1/sandboxes', { workspaceId: `ws-${n}`, machineSize: 'standard', ...extra })
    expect(res.status).toBe(200)
    return res.body.sandbox.id as string
  }
  const alice: Who = { sub: 'alice', org: 'acme', role: 'member' }
  const bob: Who = { sub: 'bob', org: 'acme', role: 'member' }
  const admin: Who = { sub: 'carol', org: 'acme', role: 'admin' }
  const eve: Who = { sub: 'eve', org: 'other', role: 'owner' }
  const solo: Who = { sub: 'sam', role: 'member' }
  return { h, req, create, alice, bob, admin, eve, solo }
}

describe('workspace numbers (W-123)', () => {
  it('numbers workspaces per account and never reuses a number', async () => {
    const t = await setup()
    const a1 = await t.create(t.alice)
    const a2 = await t.create(t.bob, { visibility: 'team' })
    const e1 = await t.create(t.eve)
    const view = async (who: Who, id: string) => (await t.req(who, 'GET', `/v1/team/workspaces/${id}`)).body.workspace
    expect((await view(t.alice, a1)).number).toBe(1)
    expect((await view(t.bob, a2)).number).toBe(2)
    expect((await view(t.eve, e1)).number).toBe(1)
    expect((await t.req(t.alice, 'DELETE', `/v1/sandboxes/${a1}`)).status).toBe(200)
    const a3 = await t.create(t.alice)
    expect((await view(t.alice, a3)).number).toBe(3)
  })

  it('backfills existing rows by creation order and seeds the counter', () => {
    const raw = new DatabaseSync(':memory:')
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url).href)
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const at = files.indexOf('0051_workspace_numbers_prefs.sql')
    for (const file of files.slice(0, at)) {
      raw.exec(readFileSync(`${dir}${file}`, 'utf8'))
    }
    const insert = raw.prepare(
      `INSERT INTO sandboxes (id, account_id, user_id, workspace_id, provider, provider_name, status, machine_size, region,
         generation, created_at, updated_at) VALUES (?, ?, 'u', ?, 'vercel', ?, 'destroyed', 'standard', 'iad1', 0, ?, ?)`
    )
    insert.run('sbx_b', 'org:a', 'w2', 'p2', 20, 20)
    insert.run('sbx_a', 'org:a', 'w1', 'p1', 10, 10)
    insert.run('sbx_c', 'org:a', 'w3', 'p3', 20, 20)
    insert.run('sbx_z', 'org:b', 'w1', 'pz', 5, 5)
    for (const file of files.slice(at)) {
      raw.exec(readFileSync(`${dir}${file}`, 'utf8'))
    }
    expect(raw.prepare('SELECT id, number FROM sandboxes ORDER BY id').all()).toEqual([
      { id: 'sbx_a', number: 1 },
      { id: 'sbx_b', number: 2 },
      { id: 'sbx_c', number: 3 },
      { id: 'sbx_z', number: 1 }
    ])
    expect(raw.prepare('SELECT * FROM org_workspace_counters ORDER BY account_id').all()).toEqual([
      { account_id: 'org:a', last_number: 3 },
      { account_id: 'org:b', last_number: 1 }
    ])
  })
})

describe('org slugs', () => {
  it('slugifies names and refuses reserved or malformed slugs', () => {
    expect(slugify('Acme Labs, Inc.')).toBe('acme-labs-inc')
    expect(slugify('Ünïcode Crew')).toBe('unicode-crew')
    expect(slugify('!!!')).toBe('team')
    expect(slugify('w')).toBe('w-team')
    expect(isValidSlug('acme')).toBe(true)
    expect(isValidSlug('w')).toBe(false)
    expect(isValidSlug('-acme')).toBe(false)
    expect(isValidSlug('a--b')).toBe(false)
    expect(isValidSlug('Acme')).toBe(false)
  })

  it('names an org once from the first name it hears, uniquely across orgs', async () => {
    const t = await setup()
    expect((await t.req(t.alice, 'GET', '/v1/team/org')).body).toEqual({ slug: null, orgId: 'acme' })
    expect((await t.req(t.alice, 'GET', '/v1/team/org?name=Acme%20Labs')).body).toEqual({ slug: 'acme-labs', orgId: 'acme' })
    // A teammate whose client shows another name still gets the org's slug.
    expect((await t.req(t.bob, 'GET', '/v1/team/org?name=Whatever')).body.slug).toBe('acme-labs')
    expect((await t.req(t.eve, 'GET', '/v1/team/org?name=Acme%20Labs')).body.slug).toBe('acme-labs-2')
    expect((await t.req(t.solo, 'GET', '/v1/team/org?name=Sam')).body).toEqual({ slug: null, orgId: null })
  })

  it('lets only admins rename, and not onto another org', async () => {
    const t = await setup()
    await t.req(t.alice, 'GET', '/v1/team/org?name=Acme')
    await t.req(t.eve, 'GET', '/v1/team/org?name=Other')
    expect((await t.req(t.alice, 'PUT', '/v1/team/org', { slug: 'acme-co' })).status).toBe(403)
    expect((await t.req(t.admin, 'PUT', '/v1/team/org', { slug: 'other' })).status).toBe(409)
    expect((await t.req(t.admin, 'PUT', '/v1/team/org', { slug: 'w' })).status).toBe(400)
    expect((await t.req(t.admin, 'PUT', '/v1/team/org', { slug: 'acme-co' })).body).toEqual({ slug: 'acme-co', orgId: 'acme' })
    expect((await t.req(t.bob, 'GET', '/v1/team/org')).body.slug).toBe('acme-co')
  })
})

describe('slug links', () => {
  it('copies org slug links and resolves them only for those who can see the workspace', async () => {
    const t = await setup()
    const id = await t.create(t.alice)
    const before = (await t.req(t.alice, 'GET', `/v1/team/workspaces/${id}`)).body.workspace
    // No slug yet: the id form still works.
    expect(before.link).toBe(`orca://cloud/w/${id}`)
    await t.req(t.alice, 'GET', '/v1/team/org?name=Acme')
    const after = (await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')).body.workspaces[0]
    expect(after.link).toBe('orca://cloud/acme/W-1')

    const resolved = await t.req(t.alice, 'GET', '/v1/team/links/resolve?org=acme&n=1&c=s:abc')
    expect(resolved.status).toBe(200)
    expect(resolved.body).toMatchObject({ workspace: { id, number: 1 }, chatId: 's:abc' })
    // Private to Alice: Bob sees nothing until she shares it.
    expect((await t.req(t.bob, 'GET', '/v1/team/links/resolve?org=acme&n=1')).status).toBe(404)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${id}`, { visibility: 'team' })
    expect((await t.req(t.bob, 'GET', '/v1/team/links/resolve?org=acme&n=1')).body.workspace.id).toBe(id)
    expect((await t.req(t.bob, 'GET', '/v1/team/links/resolve?org=acme&n=2')).status).toBe(404)
    // Another org: not found, but says which org so a member of both can switch.
    const other = await t.req(t.eve, 'GET', '/v1/team/links/resolve?org=acme&n=1')
    expect(other.status).toBe(404)
    expect(other.body).toEqual({ error: 'not_found', reason: 'other_org', orgId: 'acme' })
    expect((await t.req(t.eve, 'GET', '/v1/team/links/resolve?org=nope&n=1')).body).toEqual({ error: 'not_found' })
    expect((await t.req(t.alice, 'GET', '/v1/team/links/resolve?org=acme&n=0')).status).toBe(400)
  })
})

describe('workspace prefs (synced pins and order)', () => {
  const A = `sbx_${'a'.repeat(24)}`
  const B = `sbx_${'b'.repeat(24)}`

  it('stores one document per member and account with compare-and-set', async () => {
    const t = await setup()
    expect((await t.req(t.alice, 'GET', '/v1/team/prefs')).body).toEqual({
      document: { pinned: [], order: [], sections: [], collapsed: [] },
      revision: 0,
      updatedAt: null
    })
    const doc = { pinned: [A], order: [B], sections: ['Auth', 'Billing'], collapsed: ['Billing'] }
    const first = await t.req(t.alice, 'PUT', '/v1/team/prefs', { document: doc, revision: 0, deviceId: 'desk-1' })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ document: doc, revision: 1 })
    // A second device that still holds revision 0 must re-read before writing.
    const stale = await t.req(t.alice, 'PUT', '/v1/team/prefs', { document: { ...doc, pinned: [] }, revision: 0 })
    expect(stale.status).toBe(409)
    const second = await t.req(t.alice, 'PUT', '/v1/team/prefs', { document: { ...doc, pinned: [B, A], order: [] }, revision: 1 })
    expect(second.body.revision).toBe(2)
    expect((await t.req(t.alice, 'GET', '/v1/team/prefs')).body.document.pinned).toEqual([B, A])
    // Teammates and other accounts have their own.
    expect((await t.req(t.bob, 'GET', '/v1/team/prefs')).body.revision).toBe(0)
    expect((await t.req({ ...t.alice, org: 'other' }, 'GET', '/v1/team/prefs')).body.revision).toBe(0)
    expect((await t.req(t.solo, 'PUT', '/v1/team/prefs', { document: doc, revision: 0 })).status).toBe(200)
  })

  it('rejects malformed documents', async () => {
    const t = await setup()
    const put = (document: unknown) => t.req(t.alice, 'PUT', '/v1/team/prefs', { document, revision: 0 })
    expect((await put({ pinned: [A], order: [A], sections: [], collapsed: [] })).status).toBe(400)
    expect((await put({ pinned: [A, A], order: [], sections: [], collapsed: [] })).status).toBe(400)
    expect((await put({ pinned: ['nope'], order: [], sections: [], collapsed: [] })).status).toBe(400)
    expect((await put({ pinned: [], order: [], sections: ['x'], collapsed: [], extra: 1 })).status).toBe(400)
  })
})
