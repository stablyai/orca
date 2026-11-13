// OWNER-TRANSFER (P0). Handing a workspace to another owner used to accept any user id and rebuild
// a running VM's environment for them at once, so their personal secrets and agent account landed
// in a VM the previous owner had just been using. Now:
//   - the new owner must be in the team, by auth's live answer; anything but a clear yes refuses;
//   - the owner and a permanent "transferred" mark are written together, and the VM is stopped;
//   - a transferred workspace is in shared mode for credentials for good: nothing personal to the
//     new owner is ever attached, on transfer, wake or refresh;
//   - what acted for the previous owner (share links, the in-VM token) is revoked.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintApiKey, WORKSPACE_TOKEN_SCOPES } from '../src/api/keys'
import { connectedMembers } from '../src/member-git'
import { ENV_COMMAND, START_COMMAND } from '../src/sandbox-vm-commands'
import { ownersForSandbox } from '../src/secrets'
import { isSharedWorkspace } from '../src/shared-workspace'
import { getSandbox } from '../src/store'
import { createTeamMembershipCheck, membershipKey, MEMBERSHIP_KEY_PURPOSE, type MembershipAnswer } from '../src/team-membership'
import { createHarness } from './harness'

type Harness = Awaited<ReturnType<typeof createHarness>>

const KEK = Buffer.alloc(32, 7).toString('base64')
const AUTH_TOKEN = 'a'.repeat(40)
const OPERATOR = 'o'.repeat(40)
// Fake values only. None of the new owner's may ever reach the VM or a log line.
const TEAM_KEY = 'sk-ant-api03-fake-team-key-0000'
const MIA_VALUES = ['sk-proj-fake-mia-openai-1111', 'mia-db-password', 'mia-aws-secret-value']
const MAL_VALUE = 'mallory-own-db-password'

let logs: string[] = []
beforeEach(() => {
  logs = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    })
  }
})
afterEach(() => {
  for (const value of [...MIA_VALUES, MAL_VALUE, TEAM_KEY, AUTH_TOKEN]) {
    expect(logs.join('\n')).not.toContain(value)
  }
  vi.restoreAllMocks()
})

function decodeEnv(encoded: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (encoded ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), Buffer.from(line.slice(at + 1), 'base64').toString('utf8')]
      })
  )
}

/** Everything the control plane sent the VM from command `from` on, secrets decoded, as one string. */
function everythingSent(h: Harness, from = 0): string {
  return JSON.stringify(h.vercel.commands.slice(from).map((c) => ({ ...c, env: { ...c.env, ORCA_SECRET_ENV: decodeEnv(c.env.ORCA_SECRET_ENV) } })))
}

function lastEnv(h: Harness, command: string = START_COMMAND): Record<string, string> {
  return decodeEnv(h.vercel.commands.filter((c) => c.command === command).at(-1)?.env.ORCA_SECRET_ENV)
}

/** Mallory's private, running workspace in Acme; Mia is a teammate with personal secrets of her own. */
async function setup(deps: Parameters<typeof createHarness>[1] = {}, env: Record<string, string> = {}) {
  const h = await createHarness(
    { SECRETS_KEK: KEK, MEMBER_REMOVED_TOKEN: AUTH_TOKEN, OPERATOR_TOKEN: OPERATOR, PUBLIC_API_URL: 'https://api.test', SHARE_LINK_SECRET: 's'.repeat(40), SHARE_HOST_SUFFIX: 'share.test', ...env },
    deps
  )
  h.billing.features = { auditLog: true }
  const admin = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
  const mallory = await h.token('mallory', 'acme', 'sandbox', { orgRole: 'member' })
  const mia = await h.token('mia', 'acme', 'sandbox', { orgRole: 'member' })
  const put = (scope: string, name: string, value: string, bearer: string) => h.call('PUT', `/v1/secrets/${scope}/${name}`, { body: { value }, bearer })
  await put('org', 'ANTHROPIC_API_KEY', TEAM_KEY, admin)
  await put('personal', 'OPENAI_API_KEY', MIA_VALUES[0]!, mia)
  await put('personal', 'DB_PASSWORD', MIA_VALUES[1]!, mia)
  await put('personal', 'AWS_SECRET_ACCESS_KEY', MIA_VALUES[2]!, mia)
  await put('personal', 'DB_PASSWORD', MAL_VALUE, mallory)
  const created = await h.call('POST', '/v1/sandboxes', { bearer: mallory, body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' } } })
  expect(created.status).toBe(200)
  const id: string = created.body.sandbox.id
  const transfer = (bearer: string, ownerUserId: string) => h.call('PATCH', `/v1/team/workspaces/${id}`, { bearer, body: { ownerUserId } })
  const row = async () => (await getSandbox(h.env.SANDBOX_DB, id))!
  return { h, admin, mallory, mia, id, transfer, row, put }
}

const answers = (answer: MembershipAnswer) => ({ teamMembership: async () => answer })

describe('who a workspace may be handed to', () => {
  it('refuses someone who is not in the team, and changes nothing', async () => {
    const asked: string[][] = []
    const t = await setup({ teamMembership: async (accountId, userId) => (asked.push([accountId, userId]), { member: false }) })
    const sent = t.h.vercel.commands.length
    const refused = await t.transfer(t.mallory, 'usr_outsider')
    expect([refused.status, refused.body]).toEqual([403, { error: 'forbidden', reason: 'not_a_member' }])
    expect(asked).toEqual([['org:acme', 'usr_outsider']])
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null, status: 'running' })
    // The VM was not touched: no stop, no command.
    expect(t.h.vercel.commands.length).toBe(sent)
    expect(t.h.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'workspace.owner_changed'").get()).toEqual({ n: 0 })
  })

  it('refuses when auth cannot say, with a "try again" answer, and changes nothing', async () => {
    const t = await setup(answers({ unavailable: 'auth_502' }))
    const refused = await t.transfer(t.mallory, 'mia')
    expect([refused.status, refused.body]).toEqual([503, { error: 'unavailable', reason: 'membership_unavailable' }])
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null, status: 'running' })
  })

  it('never asks about membership for a caller who may not hand the workspace over', async () => {
    const asked: string[] = []
    const t = await setup({ teamMembership: async (_account, userId) => (asked.push(userId), { member: true }) })
    // Mia is a teammate, not the owner or an admin: a private workspace does not exist for her.
    expect((await t.transfer(t.mia, 'mia')).status).toBe(404)
    expect(asked).toEqual([])
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null })
  })

  it('with no check configured, every hand-off is refused (the interim "transfers off")', async () => {
    const t = await setup({ teamMembership: undefined })
    expect((await t.transfer(t.mallory, 'mia')).body).toEqual({ error: 'unavailable', reason: 'membership_unavailable' })
    expect((await t.transfer(t.admin, 'ada')).status).toBe(503)
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null })
  })
})

describe("auth's live membership answer", () => {
  const env = { AUTH_INTERNAL_ORIGIN: 'https://auth.test/', MEMBER_REMOVED_TOKEN: AUTH_TOKEN }
  const auth = (respond: () => Response | Promise<Response>) => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown; redirect: unknown }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)), redirect: init?.redirect })
      return respond()
    }) as typeof fetch
    return { calls, fetchImpl }
  }

  it('asks with a key derived from the shared token, never the token itself', async () => {
    const a = auth(() => Response.json({ member: true, role: 'member' }))
    expect(await createTeamMembershipCheck(env, a.fetchImpl)('org:acme', 'usr_mia')).toEqual({ member: true })
    const key = await membershipKey(AUTH_TOKEN)
    expect(a.calls).toEqual([{ url: 'https://auth.test/v1/internal/org-membership', authorization: `Bearer ${key}`, body: { orgId: 'acme', userId: 'usr_mia' }, redirect: 'manual' }])
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(key).not.toContain(AUTH_TOKEN)
    // The contract with auth (orca-cloud#798): HMAC-SHA256(token, purpose), base64url, no padding.
    expect(MEMBERSHIP_KEY_PURPOSE).toBe('orca-cloud:control-plane-to-auth:org-membership:v1')
    expect(await membershipKey(`  ${AUTH_TOKEN}\n`)).toBe(key)
    expect(await membershipKey('b'.repeat(40))).not.toBe(key)
  })

  it('reads "not a member" only from a clear 200', async () => {
    expect(await createTeamMembershipCheck(env, auth(() => Response.json({ member: false })).fetchImpl)('org:acme', 'u')).toEqual({ member: false })
  })

  it.each([
    [401, { error: 'unauthorized' }],
    [400, { error: 'invalid_request' }],
    [404, { error: 'not_found' }],
    [429, { error: 'rate_limited' }],
    [500, { error: 'boom' }],
    [502, { error: 'directory_unavailable' }],
    // A redirect is never followed, and never a yes.
    [302, null]
  ])('treats HTTP %i as "cannot say", even with member:true in the body', async (status, body) => {
    const a = auth(() => new Response(JSON.stringify({ ...(body ?? {}), member: true }), { status }))
    expect(await createTeamMembershipCheck(env, a.fetchImpl)('org:acme', 'u')).toEqual({ unavailable: `auth_${status}` })
  })

  it('treats a network failure, a timeout and an unreadable 200 as "cannot say"', async () => {
    const down = auth(() => Promise.reject(new TypeError('fetch failed')))
    expect(await createTeamMembershipCheck(env, down.fetchImpl)('org:acme', 'u')).toEqual({ unavailable: 'unreachable' })
    for (const body of ['not json', '{}', '{"member":"yes"}', '{"member":1}', 'null']) {
      const odd = auth(() => new Response(body, { status: 200 }))
      expect([body, await createTeamMembershipCheck(env, odd.fetchImpl)('org:acme', 'u')]).toEqual([body, { unavailable: 'unreadable_answer' }])
    }
  })

  it('refuses without calling auth when it is not configured, or the account is not a real team', async () => {
    const a = auth(() => Response.json({ member: true }))
    const cases: Array<[Parameters<typeof createTeamMembershipCheck>[0], string, string]> = [
      [{ MEMBER_REMOVED_TOKEN: AUTH_TOKEN }, 'org:acme', 'not_configured'],
      [{ AUTH_INTERNAL_ORIGIN: 'https://auth.test' }, 'org:acme', 'not_configured'],
      [{ AUTH_INTERNAL_ORIGIN: 'https://auth.test', MEMBER_REMOVED_TOKEN: 'short' }, 'org:acme', 'not_configured'],
      [{ AUTH_INTERNAL_ORIGIN: 'http://auth.test', MEMBER_REMOVED_TOKEN: AUTH_TOKEN }, 'org:acme', 'not_configured'],
      // Dev operator accounts are not in auth: refused, no bypass. Personal accounts have no team.
      [env, 'dev:org:w6test', 'unknown_account'],
      [env, 'user:mallory', 'unknown_account']
    ]
    for (const [config, account, reason] of cases) {
      expect([account, await createTeamMembershipCheck(config, a.fetchImpl)(account, 'u')]).toEqual([account, { unavailable: reason }])
    }
    expect(a.calls).toEqual([])
  })

  it('through the route: a member is accepted, everything else is refused', async () => {
    let next: () => Response = () => Response.json({ member: true })
    const a = auth(() => next())
    const t = await setup({ teamMembership: createTeamMembershipCheck(env, a.fetchImpl) })
    for (const [respond, status] of [
      [() => Response.json({ member: false }), 403],
      [() => Response.json({ error: 'rate_limited' }, { status: 429 }), 503],
      [() => Response.json({ error: 'directory_unavailable' }, { status: 502 }), 503],
      [() => Response.json({ error: 'not_found' }, { status: 404 }), 503],
      [() => Response.json({ error: 'unauthorized' }, { status: 401 }), 503]
    ] as Array<[() => Response, number]>) {
      next = respond
      expect((await t.transfer(t.mallory, 'mia')).status).toBe(status)
      expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null, status: 'running' })
    }
    next = () => Response.json({ member: true })
    expect((await t.transfer(t.mallory, 'mia')).status).toBe(200)
    expect(a.calls.at(-1)!.body).toEqual({ orgId: 'acme', userId: 'mia' })
  })

  it("the derived key opens nothing on the control plane's own internal routes", async () => {
    const t = await setup()
    const key = await membershipKey(AUTH_TOKEN)
    const post = (path: string, body: unknown, bearer: string) => t.h.call('POST', path, { body, bearer })
    const routes: Array<[string, unknown]> = [
      ['/v1/internal/org-members/removed', { accountId: 'org:acme', userId: 'mia' }],
      ['/v1/internal/members/role-changed', { accountId: 'org:acme', userId: 'mia', role: 'owner' }],
      ['/v1/internal/member-names', { accountId: 'org:acme', members: [{ userId: 'mia', name: 'Mia' }] }],
      ['/v1/internal/audit-events', { accountId: 'org:acme', events: [{ eventId: 'evt_00000001', action: 'member.invited' }] }]
    ]
    for (const [path, body] of routes) {
      expect([path, (await post(path, body, key)).status]).toEqual([path, 404])
      // The real shared token still works there, so the 404 above is the key being refused.
      expect([path, (await post(path, body, AUTH_TOKEN)).status]).toEqual([path, 200])
    }
    expect((await t.h.call('GET', '/v1/internal/status', { bearer: key })).status).toBe(404)
  })
})

describe('a hand-off to a teammate', () => {
  it('writes the owner and the transferred mark together, stops the VM, and rebuilds nothing for the new owner', async () => {
    const t = await setup()
    const session = (await t.row()).session_id
    // Mallory's own private workspace had her personal secret, as before.
    expect(lastEnv(t.h).DB_PASSWORD).toBe(MAL_VALUE)
    const sent = t.h.vercel.commands.length
    const moved = await t.transfer(t.mallory, 'mia')
    expect(moved.status).toBe(200)
    expect(moved.body.workspace).toMatchObject({ ownerUserId: 'mia', createdBy: 'mallory', status: 'suspended', visibility: 'private' })
    expect(moved.body.workspace.ownershipTransferredAt).toBe(t.h.now())
    const row = await t.row()
    expect(row).toMatchObject({ user_id: 'mia', created_by: 'mallory', status: 'suspended', session_id: null, visibility: 'private' })
    expect(row.ownership_transferred_at).toBe(t.h.now())
    expect(session).toBeTruthy()
    // Nothing was sent to the VM for Mia: no env refresh, no start. And none of her values, ever.
    const after = t.h.vercel.commands.slice(sent).map((c) => c.command)
    expect(after).not.toContain(ENV_COMMAND)
    expect(after).not.toContain(START_COMMAND)
    for (const value of MIA_VALUES) {
      expect(everythingSent(t.h)).not.toContain(value)
    }
    // Recorded, with both people.
    const audit = t.h.raw.prepare("SELECT user_id, detail FROM audit_log WHERE action = 'workspace.owner_changed'").all() as Array<{ user_id: string; detail: string }>
    expect(audit.map((entry) => [entry.user_id, JSON.parse(entry.detail)])).toEqual([['mallory', { fromUserId: 'mallory', toUserId: 'mia' }]])
  })

  it('treats the workspace as shared for credentials from then on, though it stays private to see', async () => {
    const t = await setup()
    await t.transfer(t.mallory, 'mia')
    const row = await t.row()
    expect(isSharedWorkspace(row)).toBe(true)
    expect(ownersForSandbox(row)).toEqual({ org: 'org:acme', personal: null, repo: 'org:acme#github.com/acme/app' })
    // Still Mia's alone to open: the mark changes credentials, not who can see it.
    expect((await t.h.call('GET', `/v1/team/workspaces/${t.id}`, { bearer: t.mallory })).status).toBe(404)
    expect((await t.h.call('GET', `/v1/team/workspaces/${t.id}`, { bearer: t.mia })).status).toBe(200)
  })

  it('a wake after the hand-off is a new session with team secrets only: nothing of the new owner, nothing of the old', async () => {
    const t = await setup()
    const before = (await t.row()).session_id
    await t.transfer(t.mallory, 'mia')
    const sent = t.h.vercel.commands.length
    const woke = await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.mia })
    expect(woke.status).toBe(200)
    const row = await t.row()
    expect(row.status).toBe('running')
    // A fresh session (the stop kept the disk only), started with a freshly built env.
    expect(row.session_id).toBeTruthy()
    expect(row.session_id).not.toBe(before)
    const env = lastEnv(t.h)
    expect(env.ANTHROPIC_API_KEY).toBeDefined()
    expect(env).not.toHaveProperty('DB_PASSWORD')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    const since = everythingSent(t.h, sent)
    for (const value of [...MIA_VALUES, MAL_VALUE]) {
      expect(since).not.toContain(value)
    }
  })

  it('an env refresh of a transferred workspace (the path refreshOwnersSandboxes uses) attaches nothing personal', async () => {
    const t = await setup()
    await t.transfer(t.mallory, 'mia')
    await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.mia })
    const sent = t.h.vercel.commands.length
    // Mia saves another personal secret: her running sandboxes are refreshed, this one included.
    await t.put('personal', 'NEW_ONE', 'mia-new-secret-value', t.mia)
    expect((await t.h.call('POST', `/v1/sandboxes/${t.id}/env/refresh`, { bearer: t.mia })).status).toBe(200)
    const since = everythingSent(t.h, sent)
    for (const value of [...MIA_VALUES, 'mia-new-secret-value']) {
      expect(since).not.toContain(value)
    }
    expect(lastEnv(t.h, ENV_COMMAND)).not.toHaveProperty('NEW_ONE')
  })

  it('handing it back does not clear the mark: still shared mode, even for its creator', async () => {
    const t = await setup()
    await t.transfer(t.mallory, 'mia')
    const first = (await t.row()).ownership_transferred_at
    t.h.advance(60_000)
    expect((await t.transfer(t.mia, 'mallory')).status).toBe(200)
    const row = await t.row()
    expect(row).toMatchObject({ user_id: 'mallory', created_by: 'mallory' })
    expect(row.ownership_transferred_at).toBeGreaterThan(first!)
    expect(ownersForSandbox(row).personal).toBeNull()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.mallory })
    expect(lastEnv(t.h)).not.toHaveProperty('DB_PASSWORD')
  })

  it('an admin taking a workspace for themselves follows the same rule', async () => {
    const t = await setup()
    await t.put('personal', 'ADMIN_ONLY', 'ada-personal-secret', t.admin)
    const taken = await t.transfer(t.admin, 'ada')
    expect(taken.status).toBe(200)
    const row = await t.row()
    expect(row).toMatchObject({ user_id: 'ada', status: 'suspended' })
    expect(row.ownership_transferred_at).not.toBeNull()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.admin })
    expect(everythingSent(t.h)).not.toContain('ada-personal-secret')
  })

  it('a hand-off of a sleeping workspace needs no stop, and is marked the same', async () => {
    const t = await setup()
    await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`, { bearer: t.mallory })
    expect((await t.transfer(t.mallory, 'mia')).status).toBe(200)
    expect(await t.row()).toMatchObject({ user_id: 'mia', status: 'suspended' })
    expect((await t.row()).ownership_transferred_at).not.toBeNull()
  })

  it.each(['creating', 'resuming', 'suspending', 'archiving', 'failed'])('refuses while the workspace is %s: never onto a boot or a stop in flight', async (status) => {
    const asked: string[] = []
    const t = await setup({ teamMembership: async (_account, userId) => (asked.push(userId), { member: true }) })
    t.h.raw.prepare('UPDATE sandboxes SET status = ? WHERE id = ?').run(status, t.id)
    const sent = t.h.vercel.commands.length
    const refused = await t.transfer(t.admin, 'mia')
    expect([refused.status, refused.body]).toEqual([409, { error: 'conflict', reason: `sandbox_${status}` }])
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null, status })
    expect(asked).toEqual([])
    expect(t.h.vercel.commands.length).toBe(sent)
  })

  it('refuses when the VM cannot be stopped: the workspace stays with its owner, unmarked', async () => {
    const t = await setup()
    const stop = t.h.vercel.stopSession.bind(t.h.vercel)
    t.h.vercel.stopSession = async () => {
      throw new Error('provider down')
    }
    const refused = await t.transfer(t.mallory, 'mia')
    expect([refused.status, refused.body]).toEqual([409, { error: 'conflict', reason: 'stop_failed' }])
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null })
    expect(t.h.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'workspace.owner_changed'").get()).toEqual({ n: 0 })
    // Once it can be stopped, the same request goes through.
    t.h.vercel.stopSession = stop
    t.h.raw.prepare("UPDATE sandboxes SET status = 'running' WHERE id = ? AND status <> 'suspended'").run(t.id)
    expect((await t.transfer(t.mallory, 'mia')).status).toBe(200)
    expect(await t.row()).toMatchObject({ user_id: 'mia', status: 'suspended' })
  })

  it('a wake that races in between the stop and the write refuses the hand-off and leaves the VM as the waker left it', async () => {
    const t = await setup()
    // The previous owner wakes it after the stop and just before the owner is written.
    const db = t.h.env.SANDBOX_DB
    const prepare = db.prepare.bind(db)
    let raced = 0
    db.prepare = ((sql: string) => {
      if (sql.includes('ownership_transferred_at = ?') && sql.startsWith('UPDATE sandboxes SET user_id')) {
        raced += 1
        t.h.raw.prepare("UPDATE sandboxes SET status = 'running', session_id = 'sess_woken_again' WHERE id = ?").run(t.id)
      }
      return prepare(sql)
    }) as typeof db.prepare
    const refused = await t.transfer(t.mallory, 'mia')
    db.prepare = prepare
    expect(raced).toBe(1)
    expect([refused.status, refused.body]).toEqual([409, { error: 'conflict', reason: 'sandbox_not_stopped' }])
    // Still Mallory's, unmarked, and running as her wake left it.
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null, status: 'running', session_id: 'sess_woken_again' })
    expect(t.h.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'workspace.owner_changed'").get()).toEqual({ n: 0 })
    for (const value of MIA_VALUES) {
      expect(everythingSent(t.h)).not.toContain(value)
    }
  })

  it('writes the owner only if the workspace is stopped at that instant', async () => {
    const t = await setup()
    // As if the previous owner woke it again between the stop and the write.
    const { transferOwnership } = await import('../src/store')
    t.h.raw.prepare("UPDATE sandboxes SET status = 'running' WHERE id = ?").run(t.id)
    expect(await transferOwnership(t.h.env.SANDBOX_DB, t.id, 'mia', t.h.now())).toBeNull()
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null })
    t.h.raw.prepare("UPDATE sandboxes SET status = 'suspended' WHERE id = ?").run(t.id)
    const before = await t.row()
    expect(await transferOwnership(t.h.env.SANDBOX_DB, t.id, 'mia', t.h.now())).toMatchObject({ user_id: 'mia', ownership_transferred_at: t.h.now() })
    // A wake that read the row before the hand-off loses its compare-and-set afterwards.
    expect((await t.row()).generation).toBe(before.generation + 1)
    const { transition } = await import('../src/store')
    expect(await transition(t.h.env.SANDBOX_DB, before, { status: 'resuming' }, t.h.now())).toBeNull()
    expect((await t.row()).status).toBe('suspended')
  })

  it('naming the current owner again is not a transfer', async () => {
    const t = await setup(answers({ member: false }))
    expect((await t.transfer(t.mallory, 'mallory')).status).toBe(200)
    expect(await t.row()).toMatchObject({ user_id: 'mallory', ownership_transferred_at: null, status: 'running' })
  })
})

describe('what acted for the previous owner', () => {
  it('share links on the workspace are turned off', async () => {
    const t = await setup()
    const share = await t.h.call('POST', `/v1/sandboxes/${t.id}/shares`, { bearer: t.mallory, body: { port: 3000, audience: 'team', expiresIn: '1h' } })
    expect(share.status).toBe(200)
    await t.transfer(t.mallory, 'mia')
    expect(t.h.raw.prepare('SELECT COUNT(*) AS live FROM share_links WHERE sandbox_id = ? AND revoked_at IS NULL').get(t.id)).toEqual({ live: 0 })
  })

  it('the in-VM API token is revoked, and none is ever minted for a transferred workspace', async () => {
    const t = await setup()
    await t.h.call('PUT', '/v1/settings', { bearer: t.admin, body: { vmCliEnabled: true } })
    // A fresh boot mints one for the owner, as before.
    await t.h.call('POST', `/v1/sandboxes/${t.id}/suspend`, { bearer: t.mallory })
    await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.mallory })
    const live = () => (t.h.raw.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE sandbox_id = ? AND kind = 'workspace' AND revoked_at IS NULL").get(t.id) as { n: number }).n
    expect(live()).toBe(1)
    await t.transfer(t.mallory, 'mia')
    expect(live()).toBe(0)
    await t.h.call('POST', `/v1/sandboxes/${t.id}/resume`, { bearer: t.mia })
    expect((await t.row()).status).toBe('running')
    expect(live()).toBe(0)
  })

  it('a workspace made from inside a transferred one starts transferred, never private with personal secrets', async () => {
    const t = await setup()
    await t.h.call('PUT', '/v1/settings', { bearer: t.admin, body: { vmCliEnabled: true } })
    await t.transfer(t.mallory, 'mia')
    // No token is minted for it now; this is one that somehow exists (belt and braces).
    const minted = await mintApiKey(t.h.env.SANDBOX_DB, { accountId: 'org:acme', createdBy: 'mia', name: 'left behind', scopes: WORKSPACE_TOKEN_SCOPES, kind: 'workspace', sandboxId: t.id, expiresAt: t.h.now() + 3_600_000 }, t.h.now())
    const sent = t.h.vercel.commands.length
    const sibling = await t.h.call('POST', '/v1/workspaces', { bearer: minted.secret, body: { name: 'sibling', repo: { url: 'https://github.com/acme/app' } } })
    expect(sibling.status).toBe(201)
    const row = (await getSandbox(t.h.env.SANDBOX_DB, sibling.body.workspace.id))!
    expect(row).toMatchObject({ user_id: 'mia', visibility: 'private' })
    expect(row.ownership_transferred_at).not.toBeNull()
    for (const value of MIA_VALUES) {
      expect(everythingSent(t.h, sent)).not.toContain(value)
    }
  })

  it("the owner's GitHub identity has no entry of its own on a transferred workspace", async () => {
    const t = await setup()
    const db = t.h.env.SANDBOX_DB
    const connect = (userId: string) =>
      t.h.raw
        .prepare(`INSERT INTO github_user_tokens (account_id, user_id, github_user_id, github_login, kek_id, wrapped_dek, ciphertext, updated_at) VALUES ('org:acme', ?, 1, ?, 'k', 'w', 'c', 1)`)
        .run(userId, userId)
    connect('mallory')
    connect('mia')
    // Before: the owner counts with no grant.
    expect(await connectedMembers(db, await t.row())).toEqual(['mallory'])
    await t.transfer(t.mallory, 'mia')
    // After: nobody without a grant, the new owner included.
    expect(await connectedMembers(db, await t.row())).toEqual([])
    // With an active grant she counts, exactly like any member of a shared workspace.
    t.h.raw
      .prepare(`INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, status, created_at) VALUES ('g1', ?, 'org:acme', 'mia', 'desktop', 'Mia', 'active', 1)`)
      .run(t.id)
    expect(await connectedMembers(db, await t.row())).toEqual(['mia'])
  })
})

describe('everything else is unchanged', () => {
  it('a workspace that was never handed over keeps its owner’s personal secrets (private) or none (shared)', async () => {
    const t = await setup()
    expect(isSharedWorkspace(await t.row())).toBe(false)
    expect(lastEnv(t.h).DB_PASSWORD).toBe(MAL_VALUE)
    expect((await t.h.call('PATCH', `/v1/team/workspaces/${t.id}`, { bearer: t.mallory, body: { visibility: 'team' } })).status).toBe(200)
    expect(await t.row()).toMatchObject({ ownership_transferred_at: null, status: 'running', visibility: 'team' })
    // Sharing still rebuilds the running env at once, without the owner's personal secrets.
    expect(lastEnv(t.h, ENV_COMMAND)).not.toHaveProperty('DB_PASSWORD')
    expect((await t.h.call('PATCH', `/v1/team/workspaces/${t.id}`, { bearer: t.mallory, body: { visibility: 'private' } })).status).toBe(200)
    expect(lastEnv(t.h, ENV_COMMAND).DB_PASSWORD).toBe(MAL_VALUE)
  })

  it('the migration marks workspaces whose owner is not their creator, and no others', async () => {
    const t = await setup()
    const second = await t.h.call('POST', '/v1/sandboxes', { bearer: t.mia, body: { workspaceId: 'ws-2', machineSize: 'standard' } })
    // As a row transferred before the fix looked: a new owner, no mark.
    t.h.raw.prepare("UPDATE sandboxes SET user_id = 'mia' WHERE id = ?").run(t.id)
    const sql = readFileSync(fileURLToPath(new URL('../migrations/0059_ownership_transferred.sql', import.meta.url).href), 'utf8')
    const backfill = sql.slice(sql.indexOf('UPDATE sandboxes'))
    t.h.raw.exec(backfill)
    expect((await t.row()).ownership_transferred_at).not.toBeNull()
    expect((await getSandbox(t.h.env.SANDBOX_DB, second.body.sandbox.id))!.ownership_transferred_at).toBeNull()
  })
})

describe('telling the previous owner', () => {
  const emails = () => {
    const sent: unknown[] = []
    return { sent, transferNotifier: async (request: unknown) => (sent.push(request), { emailed: false, mode: 'log', reason: 'logged' }) }
  }
  const notices = (h: Harness, bearer: string) => h.call('GET', '/v1/team/notices', { bearer })
  const auditRows = (h: Harness) =>
    (h.raw.prepare("SELECT actor_type, user_id, target_id, detail FROM audit_log WHERE action = 'workspace.owner_notified'").all() as Array<{ actor_type: string; user_id: string | null; target_id: string; detail: string }>).map((row) => ({
      ...row,
      detail: JSON.parse(row.detail) as Record<string, unknown>
    }))

  it('an admin takes a workspace: the owner gets a notice in Orca, an email is asked for, and the audit log says what reached them', async () => {
    const e = emails()
    const t = await setup({ transferNotifier: e.transferNotifier })
    await t.h.call('PATCH', `/v1/team/workspaces/${t.id}`, { bearer: t.mallory, body: { title: 'checkout' } })
    const moved = await t.transfer(t.admin, 'mia')
    expect(moved.status).toBe(200)
    // For the admin's result: the previous owner will see a notice (still in the team); no email was delivered.
    expect(moved.body.previousOwner).toEqual({ userId: 'mallory', notified: true, inApp: true, emailed: false })
    const row = await t.row()
    expect(e.sent).toEqual([
      { accountId: 'org:acme', eventId: `wst_${t.id}_${row.ownership_transferred_at}`, previousOwnerUserId: 'mallory', actorUserId: 'ada', newOwnerUserId: 'mia', workspaceName: 'checkout', workspaceNumber: row.number }
    ])
    const mine = await notices(t.h, t.mallory)
    expect(mine.status).toBe(200)
    expect(mine.body.notices).toEqual([
      { id: expect.stringMatching(/^otn_/), kind: 'workspace_owner_changed', workspace: { id: t.id, name: 'checkout', number: row.number }, actor: { userId: 'ada', name: null }, newOwner: { userId: 'mia', name: null }, at: row.ownership_transferred_at }
    ])
    // Nobody else sees it: not the new owner, not the admin who did it.
    expect((await notices(t.h, t.mia)).body.notices).toEqual([])
    expect((await notices(t.h, t.admin)).body.notices).toEqual([])
    expect(auditRows(t.h)).toEqual([{ actor_type: 'system', user_id: null, target_id: t.id, detail: { toUserId: 'mallory', reached: true, inApp: true, emailed: false, emailMode: 'log' } }])
    // No secret, and no value of anyone's, in the notice, the audit row or the email request.
    for (const value of [...MIA_VALUES, MAL_VALUE, TEAM_KEY]) {
      expect(JSON.stringify([mine.body, auditRows(t.h), e.sent])).not.toContain(value)
    }
  })

  it('only the person it is for can dismiss it, once', async () => {
    const t = await setup()
    await t.transfer(t.admin, 'mia')
    const id: string = (await notices(t.h, t.mallory)).body.notices[0].id
    expect((await t.h.call('POST', `/v1/team/notices/${id}/dismiss`, { bearer: t.mia })).status).toBe(404)
    expect((await t.h.call('POST', `/v1/team/notices/${id}/dismiss`, { bearer: t.admin })).status).toBe(404)
    expect((await notices(t.h, t.mallory)).body.notices).toHaveLength(1)
    expect((await t.h.call('POST', `/v1/team/notices/${id}/dismiss`, { bearer: t.mallory })).body).toEqual({ dismissed: true })
    expect((await notices(t.h, t.mallory)).body.notices).toEqual([])
    expect((await t.h.call('POST', `/v1/team/notices/${id}/dismiss`, { bearer: t.mallory })).status).toBe(404)
    expect((await t.h.call('GET', '/v1/team/notices', { bearer: 'not-a-token' })).status).toBe(401)
  })

  it('a previous owner who has left the team cannot be reached: said so to the admin and in the audit log', async () => {
    // Auth: Mia (the new owner) is in the team; Mallory (the previous owner) no longer is.
    const t = await setup({ teamMembership: async (_account, userId) => ({ member: userId !== 'mallory' }) })
    const moved = await t.transfer(t.admin, 'mia')
    expect(moved.status).toBe(200)
    expect(moved.body.previousOwner).toEqual({ userId: 'mallory', notified: false, inApp: false, emailed: false })
    expect(auditRows(t.h)[0]!.detail).toMatchObject({ toUserId: 'mallory', reached: false, inApp: false, emailed: false })
  })

  it('an email only counts when it was really delivered, never when it was just recorded', async () => {
    const left = { teamMembership: async (_account: string, userId: string) => ({ member: userId !== 'mallory' }) }
    const logged = await setup({ ...left, transferNotifier: async () => ({ emailed: false, mode: 'log', reason: 'logged' }) })
    expect((await logged.transfer(logged.admin, 'mia')).body.previousOwner.notified).toBe(false)
    const delivered = await setup({ ...left, transferNotifier: async () => ({ emailed: true, mode: 'live', reason: null }) })
    expect((await delivered.transfer(delivered.admin, 'mia')).body.previousOwner).toEqual({ userId: 'mallory', notified: true, inApp: false, emailed: true })
  })

  it('handing it over yourself still leaves you a notice, with no membership question about you', async () => {
    const asked: string[] = []
    const t = await setup({ teamMembership: async (_account, userId) => (asked.push(userId), { member: true }) })
    const moved = await t.transfer(t.mallory, 'mia')
    expect(moved.body.previousOwner).toMatchObject({ userId: 'mallory', notified: true, inApp: true })
    // Auth was asked about the new owner only.
    expect(asked).toEqual(['mia'])
    expect((await notices(t.h, t.mallory)).body.notices[0]).toMatchObject({ actor: { userId: 'mallory' }, newOwner: { userId: 'mia' } })
  })

  it('a failing notifier, or auth being unable to say, never fails or undoes the hand-off', async () => {
    let calls = 0
    const t = await setup({
      transferNotifier: async () => {
        throw new Error('auth down')
      },
      // Yes for the new owner; cannot say for the previous one.
      teamMembership: async () => (calls++ === 0 ? { member: true } : { unavailable: 'auth_502' })
    })
    const moved = await t.transfer(t.admin, 'mia')
    expect(moved.status).toBe(200)
    expect(await t.row()).toMatchObject({ user_id: 'mia', status: 'suspended' })
    expect(moved.body.previousOwner).toEqual({ userId: 'mallory', notified: false, inApp: false, emailed: false })
    // The notice is stored all the same: they see it if they can still sign in to the team.
    expect((await notices(t.h, t.mallory)).body.notices).toHaveLength(1)
  })

  it('a refused hand-off tells nobody anything', async () => {
    const e = emails()
    const t = await setup({ transferNotifier: e.transferNotifier, teamMembership: async () => ({ member: false }) })
    expect((await t.transfer(t.admin, 'usr_outsider')).status).toBe(403)
    expect(e.sent).toEqual([])
    expect((await notices(t.h, t.mallory)).body.notices).toEqual([])
    expect(auditRows(t.h)).toEqual([])
  })

  it('asks auth for the email with its own derived key, and reads only a real delivery as sent', async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = []
    let respond: () => Response = () => Response.json({ sent: false, mode: 'log', reason: 'logged' })
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return respond()
    }) as typeof fetch
    const { createTransferNotifier, NOTIFY_KEY_PURPOSE } = await import('../src/owner-transfer-notices')
    const { derivedAuthKey } = await import('../src/team-membership')
    const env = { AUTH_INTERNAL_ORIGIN: 'https://auth.test', MEMBER_REMOVED_TOKEN: AUTH_TOKEN }
    const request = { accountId: 'org:acme', eventId: 'wst_sbx_1_5', previousOwnerUserId: 'usr_a', actorUserId: 'usr_b', newOwnerUserId: 'usr_c', workspaceName: 'x'.repeat(2000), workspaceNumber: 7 }
    expect(await createTransferNotifier(env, fetchImpl)(request)).toEqual({ emailed: false, mode: 'log', reason: 'logged' })
    const key = await derivedAuthKey(AUTH_TOKEN, NOTIFY_KEY_PURPOSE)
    expect(NOTIFY_KEY_PURPOSE).toBe('orca-cloud:control-plane-to-auth:notify-workspace-transferred:v1')
    expect(calls[0]).toEqual({
      url: 'https://auth.test/v1/internal/notify/workspace-transferred',
      authorization: `Bearer ${key}`,
      body: { eventId: 'wst_sbx_1_5', orgId: 'acme', previousOwnerUserId: 'usr_a', actorUserId: 'usr_b', newOwnerUserId: 'usr_c', workspaceName: 'x'.repeat(1024), workspaceNumber: 7 }
    })
    // Neither key works for the other route.
    expect(key).not.toBe(await membershipKey(AUTH_TOKEN))
    respond = () => Response.json({ sent: true, mode: 'log' })
    expect((await createTransferNotifier(env, fetchImpl)(request)).emailed).toBe(false)
    respond = () => Response.json({ sent: true })
    expect((await createTransferNotifier(env, fetchImpl)(request)).emailed).toBe(false)
    respond = () => Response.json({ sent: true, mode: 'test-inbox' })
    expect((await createTransferNotifier(env, fetchImpl)(request)).emailed).toBe(true)
    for (const [answer, reason] of [
      [() => Response.json({ error: 'unauthorized' }, { status: 401 }), 'auth_401'],
      [() => Response.json({ error: 'rate_limited' }, { status: 429 }), 'auth_429'],
      [() => new Response('nope', { status: 200 }), 'unreadable_answer']
    ] as Array<[() => Response, string]>) {
      respond = answer
      expect(await createTransferNotifier(env, fetchImpl)(request)).toEqual({ emailed: false, mode: null, reason })
    }
    const before = calls.length
    expect(await createTransferNotifier({ MEMBER_REMOVED_TOKEN: AUTH_TOKEN }, fetchImpl)(request)).toEqual({ emailed: false, mode: null, reason: 'not_configured' })
    expect(await createTransferNotifier(env, fetchImpl)({ ...request, accountId: 'dev:org:x' })).toEqual({ emailed: false, mode: null, reason: 'not_configured' })
    expect(calls.length).toBe(before)
  })

  it('the workspace views carry the mark, so a client can show that the owner changed', async () => {
    const t = await setup()
    const before = await t.h.call('GET', `/v1/workspaces/${t.id}`, { bearer: t.mallory })
    expect(before.body.workspace.ownershipTransferredAt).toBeNull()
    await t.transfer(t.mallory, 'mia')
    const mark = (await t.row()).ownership_transferred_at
    const after = await t.h.call('GET', `/v1/workspaces/${t.id}`, { bearer: t.mia })
    expect(after.body.workspace.ownershipTransferredAt).toBe(mark)
    const listed = await t.h.call('GET', '/v1/team/workspaces?scope=mine', { bearer: t.mia })
    expect(listed.body.workspaces.find((w: { id: string }) => w.id === t.id).ownershipTransferredAt).toBe(mark)
  })
})
