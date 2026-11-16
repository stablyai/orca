// GH-SOLO regression (orca-plugins#89): in a workspace only one person can use, the server acts as that person
// (memberMayAct), but the VM picked a member only from an attested sender. Codex typed into directly in a
// terminal has none, so gh and git went out as the bot. Now the VM acts as the solo member with no sender too.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { generateGrantRecipientKey } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { GRANT_COMMAND } from '../src/grants'
import { DROP_SOLO_SCRIPT, MEMBERS_COMMAND } from '../src/lifecycle'
import { soloMember } from '../src/member-git'
import { getSandbox } from '../src/store'
import { createHarness } from './harness'

const IDENTITY = fileURLToPath(new URL('../image/vm/orca-git-identity', import.meta.url).href)
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

/** orca-git-identity as root would run it, against a scratch members dir, with no orcad (so no attested sender). */
function identity(members: { solo?: string; files: Record<string, string> }, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-git-solo-'))
  dirs.push(root)
  const dir = join(root, 'members')
  mkdirSync(dir)
  mkdirSync(join(root, 'bin'))
  for (const [name, email] of Object.entries(members.files)) {
    execFileSync('git', ['config', '-f', join(dir, `${name}.gitconfig`), 'user.email', email])
  }
  if (members.solo) {
    writeFileSync(join(dir, 'solo'), `${members.solo}\n`)
  }
  // `sudo -u <caller> mktemp` and `pgrep` stand-ins: no orcad runs here.
  writeFileSync(join(root, 'bin/sudo'), '#!/usr/bin/env bash\nshift 2\nexec "$@"\n')
  writeFileSync(join(root, 'bin/pgrep'), '#!/usr/bin/env bash\nexit 1\n')
  chmodSync(join(root, 'bin/sudo'), 0o755)
  chmodSync(join(root, 'bin/pgrep'), 0o755)
  const script = join(root, 'orca-git-identity')
  writeFileSync(script, readFileSync(IDENTITY, 'utf8').replace('DIR=/etc/orca/members', `DIR=${dir}`))
  const run = spawnSync('bash', [script], { env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, SUDO_USER: 'vercel-sandbox', ...env }, encoding: 'utf8' })
  const out = run.stdout.trim()
  return { status: run.status, stderr: run.stderr, email: run.status === 0 ? execFileSync('git', ['config', '-f', out, 'user.email'], { encoding: 'utf8' }).trim() : null }
}

describe('orca-git-identity in a one-person workspace', () => {
  it('acts as the solo member with no attested sender (a TUI typed into directly)', () => {
    expect(identity({ solo: 'user_neil', files: { user_neil: '1+neil@users.noreply.github.com' } })).toMatchObject({ status: 0, email: '1+neil@users.noreply.github.com' })
    expect(identity({ solo: 'user_neil', files: { user_neil: '1+neil@users.noreply.github.com' } }, { ORCA_GIT_AS: 'user_neil' }).status).toBe(0)
  })

  it('never for anyone else, and not at all once the workspace is shared (no solo mark)', () => {
    const other = identity({ solo: 'user_neil', files: { user_neil: '1+neil@users.noreply.github.com' } }, { ORCA_GIT_AS: 'user_bob' })
    expect(other.status).toBe(4)
    expect(identity({ files: { user_neil: '1+neil@users.noreply.github.com' } }).status).toBe(3)
    // A mark naming someone with no identity installed: the workspace identity.
    expect(identity({ solo: 'user_ghost', files: {} }).status).toBe(3)
  })
})

const OP = 'o'.repeat(40)
const REPO = 'https://github.com/acme/app'

async function workspace(extra: Record<string, string> = {}) {
  const h = await createHarness(
    { EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy', SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'), OPERATOR_TOKEN: OP, ...extra },
    {
      credentials: { authorizationFor: async () => 'Bearer ghs_app' },
      github: { tokenForRepo: async () => ({ token: 'ghs_repo', expiresAt: h.now() + 3_600_000 }), installationForRepo: async () => null } as never
    }
  )
  const as = (sub: string) => h.token(sub, 'acme', 'sandbox', { org_role: 'member' })
  const created = await h.call('POST', '/v1/sandboxes', { bearer: await as('alice'), body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: REPO }, visibility: 'team' } })
  const id = created.body.sandbox.id as string
  const connect = (userId: string, githubUserId: number) =>
    h.call('POST', '/v1/internal/dev/member-github', { bearer: OP, body: { accountId: 'org:acme', userId, repoUrl: REPO, login: `${userId}-gh`, githubUserId, name: userId } })
  const grant = async (userId: string) =>
    h.call('POST', `/v1/team/workspaces/${id}/grants`, {
      bearer: await as(userId),
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: userId, deviceKind: 'desktop' }
    })
  const syncs = () => h.vercel.commands.filter((c) => c.command === MEMBERS_COMMAND)
  const restart = async () => expect((await h.call('POST', `/v1/sandboxes/${id}/restart`, { bearer: await as('alice') })).status).toBe(200)
  return { h, as, id, connect, grant, syncs, restart }
}

describe('the control plane marks a workspace solo only while one person can use it', () => {
  it('sends ORCA_SOLO_MEMBER for the owner alone; drops the mark before pairing anyone else, then sends none', async () => {
    const t = await workspace()
    await t.connect('alice', 11)
    await t.restart()
    expect(t.syncs().at(-1)!.env.ORCA_SOLO_MEMBER).toBe('alice')
    const before = t.h.vercel.commands.length
    expect((await t.grant('bob')).status).toBe(200)
    const after = t.h.vercel.commands.slice(before)
    const drop = after.findIndex((c) => c.command === 'bash' && c.args?.includes(DROP_SOLO_SCRIPT))
    const pair = after.findIndex((c) => c.command === GRANT_COMMAND)
    expect(drop).toBeGreaterThanOrEqual(0)
    expect(drop).toBeLessThan(pair)
    expect(t.syncs().at(-1)!.env.ORCA_SOLO_MEMBER).toBeUndefined()
  })

  it('review HIGH: shared with the cap off, a grantee who sent last is never marked solo (the owner has no grant row)', async () => {
    const t = await workspace({ MEMBER_GIT_SHARED_MAX_MINUTES: '0' })
    await t.connect('alice', 11)
    await t.connect('bob', 22)
    expect((await t.grant('bob')).status).toBe(200)
    expect((await t.h.call('POST', `/v1/team/workspaces/${t.id}/sent`, { bearer: await t.as('bob') })).status).toBe(200)
    await t.restart()
    expect(t.syncs().at(-1)!.env.ORCA_SOLO_MEMBER).toBeUndefined()
    expect(await soloMember(t.h.env.SANDBOX_DB, (await getSandbox(t.h.env.SANDBOX_DB, t.id))!)).toBeNull()
  })

  it('review medium: a grant that starts while the members write is in flight drops the mark again after it', async () => {
    const t = await workspace()
    await t.connect('alice', 11)
    // Bob's grant row appears (issuing) between the sync's read and its VM write.
    t.h.vercel.commandHandler = (params) => {
      if (params.command === MEMBERS_COMMAND) {
        t.h.raw
          .prepare(`INSERT INTO workspace_grants (id, sandbox_id, account_id, user_id, device_kind, device_label, status, created_at) VALUES ('grt_race', ?, 'org:acme', 'bob', 'desktop', 'b', 'issuing', 1)`)
          .run(t.id)
        return { exitCode: 0, stdout: '{"members":1,"devices":0}\n', stderr: '' }
      }
      return undefined
    }
    const before = t.h.vercel.commands.length
    await t.restart()
    const after = t.h.vercel.commands.slice(before)
    const write = after.findIndex((c) => c.command === MEMBERS_COMMAND && c.env.ORCA_SOLO_MEMBER === 'alice')
    const drop = after.findIndex((c, i) => i > write && c.command === 'bash' && c.args?.includes(DROP_SOLO_SCRIPT))
    expect(write).toBeGreaterThanOrEqual(0)
    expect(drop).toBeGreaterThan(write)
  })
})
