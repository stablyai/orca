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

describe('the control plane marks a workspace solo only while one person can use it', () => {
  it('sends ORCA_SOLO_MEMBER for the owner alone; drops the mark before pairing anyone else, then sends none', async () => {
    const h = await createHarness({ EGRESS_PROXY_URL: 'https://sandbox.test/v1/egress/proxy', SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'), OPERATOR_TOKEN: 'o'.repeat(40) }, {
      credentials: { authorizationFor: async () => 'Bearer ghs_app' },
      github: { tokenForRepo: async () => ({ token: 'ghs_repo', expiresAt: h.now() + 3_600_000 }), installationForRepo: async () => null } as never
    })
    const as = (sub: string) => h.token(sub, 'acme', 'sandbox', { org_role: 'member' })
    const created = await h.call('POST', '/v1/sandboxes', {
      bearer: await as('alice'),
      body: { workspaceId: 'ws-1', machineSize: 'standard', repo: { url: 'https://github.com/acme/app' }, visibility: 'team' }
    })
    const id = created.body.sandbox.id as string
    await h.call('POST', '/v1/internal/dev/member-github', {
      bearer: 'o'.repeat(40),
      body: { accountId: 'org:acme', userId: 'alice', repoUrl: 'https://github.com/acme/app', login: 'alice-gh', githubUserId: 11, name: 'Alice' }
    })
    // A restart re-syncs member identities: alone, she's the solo member.
    expect((await h.call('POST', `/v1/sandboxes/${id}/restart`, { bearer: await as('alice') })).status).toBe(200)
    const syncs = () => h.vercel.commands.filter((c) => c.command === MEMBERS_COMMAND)
    expect(syncs().at(-1)!.env.ORCA_SOLO_MEMBER).toBe('alice')
    const before = h.vercel.commands.length
    const grant = await h.call('POST', `/v1/team/workspaces/${id}/grants`, {
      bearer: await as('bob'),
      body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'b', deviceKind: 'desktop' }
    })
    expect(grant.status).toBe(200)
    const after = h.vercel.commands.slice(before)
    const drop = after.findIndex((c) => c.command === 'bash' && c.args?.includes(DROP_SOLO_SCRIPT))
    const pair = after.findIndex((c) => c.command === GRANT_COMMAND)
    expect(drop).toBeGreaterThanOrEqual(0)
    expect(drop).toBeLessThan(pair)
    expect(syncs().at(-1)!.env.ORCA_SOLO_MEMBER).toBeUndefined()
  })
})
