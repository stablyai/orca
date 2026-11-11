import { mkdtempSync, writeFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { generateGrantRecipientKey, nodeSealedGrantPrimitives } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { openReadSnapshot, type ReadSnapshot } from '../../../../src/shared/cloud-workspaces/read-snapshot'
import { checkReadSnapshotPin, verifyReadSnapshotSigner } from '../../../../src/shared/cloud-workspaces/read-snapshot-signature'
import type { RunCommandParams } from '../src/sandbox-provider'
import { MAX_READ_RECIPIENTS, READ_SNAPSHOT_COMMAND } from '../src/read-snapshots'
import { createHarness } from './harness'

// The real VM collector + sealer (image/vm/orca-read-snapshot.cjs), fed a fake orcad.
const require = createRequire(import.meta.url)
const vm = require('../image/vm/orca-read-snapshot.cjs') as {
  seal: (payload: unknown, recipients: unknown[], workspaceId: string, snapshotId: string) => Record<string, unknown>
  gather: (call: (method: string, params: unknown) => Promise<unknown>, opts: Record<string, unknown>) => Promise<Record<string, unknown>>
  fitToBudget: <T>(payload: T, maxBytes?: number) => T
  storedSessions: (dataDir: string) => Record<string, unknown>[]
  signingKey: (stateDir: string) => { publicKeyB64: string }
  workspaceCheckout: (worktrees: Record<string, unknown>[], sessions: Record<string, unknown>[]) => Record<string, unknown> | null
  sign: (out: Record<string, unknown>, key: unknown) => { publicKeyB64: string; signatureB64: string }
}

// The VM's signing key lives on its own disk; here, a temp dir standing in for ~/.orca-sandbox.
const VM_STATE = mkdtempSync(join(tmpdir(), 'orca-sandbox-'))
const ed25519Verify = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) =>
  verify(null, message, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey).toString('base64url') }, format: 'jwk' }), signature)

const SECRET_LINE = 'the deploy key is in 1password, not in the repo'

function fakeOrcad(method: string, params?: unknown): unknown {
  switch (method) {
    case 'worktree.ps':
      return {
        worktrees: [
          {
            path: '/vercel/sandbox/project',
            // Live right now: its status wins over the stored one.
            agents: [{ paneKey: 'structured-agent-session-chat-2:leaf-1', agentType: 'codex', state: 'working', conversationName: 'Add tests', updatedAt: 1 }],
            linkedPR: { number: 42, title: 'Fix login', state: 'open', url: 'https://github.com/acme/app/pull/42', checksStatus: 'success', checksSummary: '3/3 passed' }
          }
        ]
      }
    case 'git.status':
      return { branch: 'refs/heads/fix/login', head: 'abc1234', entries: [{ path: 'src/login.ts', status: 'modified', area: 'unstaged', added: 12, removed: 3 }] }
    case 'git.history':
      return { items: [{ id: 'abc1234', subject: 'Fix the login redirect', author: 'Alice', timestamp: 1 }] }
    case 'agentSession.history':
      // chat-2 has no readable history yet: its stored last turn stands in.
      if ((params as { sessionId?: string })?.sessionId === 'chat-2') {
        return null
      }
      return {
        page: {
          hasOlder: false,
          items: [
            { itemId: 'i1', observedAt: 1, body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Why does login loop?' }] } },
            { itemId: 'i2', observedAt: 2, body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: SECRET_LINE }] } },
            { itemId: 'i3', observedAt: 3, body: { kind: 'tool', blocks: [] } }
          ]
        }
      }
    default:
      return null
  }
}

/** What orca-sandbox-read-snapshot does on a VM, minus the socket: gather from orcad, then seal. */
async function runVmSealer(params: RunCommandParams): Promise<string> {
  const env = params.env ?? {}
  const payload = vm.fitToBudget(
    await vm.gather(async (method, params) => fakeOrcad(method, params), {
      workspaceId: env.ORCA_READ_WORKSPACE_ID,
      snapshotId: env.ORCA_READ_SNAPSHOT_ID,
      reason: env.ORCA_READ_REASON,
      now: 1_800_000_000_000,
      deadline: Date.now() + 10_000,
      // What orcad's session store holds (agent-session-journal.db on the VM).
      listSessions: () => [
        { sessionId: 'chat-1', agent: 'claude', title: 'Fix login', status: 'idle', turnOutcome: 'success', updatedAt: 2, open: true },
        { sessionId: 'chat-2', agent: 'codex', title: 'Add tests', status: 'idle', updatedAt: 1, open: true, lastPrompt: 'Add tests', lastReply: null, lastAt: 1 }
      ]
    })
  )
  const out = vm.seal(payload, JSON.parse(env.ORCA_READ_RECIPIENTS ?? '[]'), env.ORCA_READ_WORKSPACE_ID!, env.ORCA_READ_SNAPSHOT_ID!)
  out.signature = vm.sign(out, vm.signingKey(VM_STATE))
  return `${JSON.stringify(out)}\n`
}

async function setup() {
  vi.spyOn(console, 'log').mockImplementation((line: string) => { if (process.env.DBG && String(line).includes('read_snapshot')) process.stderr.write(line + '\n') })
  const h = await createHarness({ OPERATOR_TOKEN: 'o'.repeat(40) })
  // The fake's runCommand awaits whatever the handler returns, so the real (async) sealer can run.
  let vmUp = true
  h.vercel.commandHandler = ((params: RunCommandParams) => {
    if (params.command !== READ_SNAPSHOT_COMMAND) {
      return undefined
    }
    return vmUp
      ? runVmSealer(params).then((stdout) => ({ exitCode: 0, stdout, stderr: '' }))
      : { exitCode: 3, stdout: '', stderr: 'orcad not running' }
  }) as never
  type Who = { sub: string; org: string; role: 'owner' | 'admin' | 'member' }
  const as = (sub: string, role: Who['role'] = 'member', org = 'acme'): Who => ({ sub, org, role })
  const req = async (who: Who, method: string, path: string, body?: unknown) =>
    h.call(method, path, { bearer: await h.token(who.sub, who.org, 'sandbox', { org_role: who.role }), body })
  const alice = as('alice')
  const bob = as('bob')
  const created = await req(alice, 'POST', '/v1/sandboxes', {
    workspaceId: 'ws-1',
    machineSize: 'standard',
    title: 'Fix login',
    repo: { url: 'https://github.com/acme/app', ref: 'fix/login' }
  })
  expect(created.status).toBe(200)
  const id = created.body.sandbox.id as string
  const register = async (who: Who, kind: 'desktop' | 'mobile' = 'desktop', bearer?: string) => {
    const key = generateGrantRecipientKey()
    const res = bearer
      ? await h.call('PUT', '/v1/reader-keys', { bearer, body: { publicKeyB64: key.publicKeyB64, deviceLabel: `${who.sub} ${kind}`, deviceKind: kind } })
      : await req(who, 'PUT', '/v1/reader-keys', { publicKeyB64: key.publicKeyB64, deviceLabel: `${who.sub} ${kind}`, deviceKind: kind })
    expect(res.status).toBe(200)
    return { ...key, id: res.body.readerKey.id as string }
  }
  /** Sleep the workspace (the drain seals first). `orcadDown`: the VM script finds no orcad. */
  const sleep = async (who: Who = alice, orcadDown = false) => {
    vmUp = !orcadDown
    return req(who, 'POST', `/v1/sandboxes/${id}/suspend`)
  }
  const read = (who: Who, keyId: string, bearer?: string) =>
    bearer
      ? h.call('GET', `/v1/team/workspaces/${id}/read-snapshot?keyId=${keyId}`, { bearer })
      : req(who, 'GET', `/v1/team/workspaces/${id}/read-snapshot?keyId=${keyId}`)
  const open = async (body: { snapshot: never }, secretKey: Uint8Array): Promise<ReadSnapshot> =>
    openReadSnapshot(body.snapshot, id, secretKey, nodeSealedGrantPrimitives)
  return { h, req, as, alice, bob, id, register, sleep, read, open }
}

describe('read snapshots of sleeping workspaces (E2EE)', () => {
  it('seals at sleep to the owner devices; the control plane stores only ciphertext; the VM stays asleep', async () => {
    const t = await setup()
    const laptop = await t.register(t.alice)
    const phone = await t.register(t.alice, 'mobile')
    expect((await t.sleep()).status).toBe(200)
    const row = t.h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(t.id) as { status: string }
    expect(row.status).toBe('suspended')

    const before = t.h.vercel.commands.length
    for (const key of [laptop, phone]) {
      const res = await t.read(t.alice, key.id)
      expect(res.status).toBe(200)
      const snap = await t.open(res.body, key.secretKey)
      expect(snap.sessions.map((s) => [s.agent, s.title, s.status])).toEqual([
        ['claude', 'Fix login', 'idle'],
        ['codex', 'Add tests', 'working']
      ])
      expect(snap.sessions[0]!.messages.map((m) => m.text)).toEqual(['Why does login loop?', SECRET_LINE])
      expect(snap.git).toMatchObject({ branch: 'fix/login', changeCount: 1, added: 12, removed: 3 })
      expect(snap.pr).toMatchObject({ number: 42, url: 'https://github.com/acme/app/pull/42', checksStatus: 'success' })
      // Only this device's wrapped key is handed out.
      expect(res.body.snapshot.recipient.keyId).toBe(key.id)
    }
    // Reading never touched the VM.
    expect(t.h.vercel.commands.length).toBe(before)
    expect((t.h.raw.prepare('SELECT status FROM sandboxes WHERE id = ?').get(t.id) as { status: string }).status).toBe('suspended')
    // Nothing readable at rest.
    const dump = JSON.stringify([
      t.h.raw.prepare('SELECT * FROM read_snapshots').all(),
      t.h.raw.prepare('SELECT * FROM read_snapshot_keys').all()
    ])
    expect(dump).not.toContain('1password')
    expect(dump).not.toContain('login loop')
    // The list says when, for "As of" without fetching the blob.
    const list = await t.req(t.alice, 'GET', '/v1/team/workspaces?scope=mine')
    expect(list.body.workspaces[0].readSnapshotAt).toBe(t.h.now())
  })

  it('opens for teammates only on team workspaces; private stays owner-only; bad keys and other people’s keys are refused', async () => {
    const t = await setup()
    const own = await t.register(t.alice)
    const bobs = await t.register(t.bob)
    await t.sleep()
    // Private: Bob can't see it at all, and was never a recipient.
    expect((await t.read(t.bob, bobs.id)).body).toEqual({ error: 'not_found' })
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/resume`)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.sleep()
    const res = await t.read(t.bob, bobs.id)
    expect(res.status).toBe(200)
    expect((await t.open(res.body, bobs.secretKey)).sessions).toHaveLength(2)
    // Bob can't fetch Alice's wrapped key, nor open his blob with another key.
    expect((await t.read(t.bob, own.id)).status).toBe(400)
    await expect(t.open(res.body, own.secretKey)).rejects.toThrow('decrypt_failed')
    // Another org's member sees nothing.
    const mallory = t.as('mallory', 'member', 'evil')
    const mk = await t.register(mallory)
    expect((await t.read(mallory, mk.id)).status).toBe(404)
  })

  it('making it private prunes teammates at once, without the VM', async () => {
    const t = await setup()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    const own = await t.register(t.alice)
    const bobs = await t.register(t.bob)
    await t.sleep()
    expect((await t.read(t.bob, bobs.id)).status).toBe(200)
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'private' })
    expect((await t.read(t.bob, bobs.id)).status).toBe(404)
    expect(t.h.raw.prepare('SELECT key_id FROM read_snapshot_keys').all()).toEqual([{ key_id: own.id }])
    // Even back to team: Bob's wrapped key is gone until the next sleep re-seals.
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    expect((await t.read(t.bob, bobs.id)).body).toEqual({ error: 'not_sealed_for_key' })
  })

  it('a removed member can no longer read, and their wrapped keys are deleted', async () => {
    const t = await setup()
    await t.req(t.alice, 'PATCH', `/v1/team/workspaces/${t.id}`, { visibility: 'team' })
    await t.register(t.alice)
    const bobs = await t.register(t.bob)
    await t.sleep()
    expect((await t.read(t.bob, bobs.id)).status).toBe(200)
    const removed = await t.h.call('POST', '/v1/internal/org-members/removed', { bearer: 'o'.repeat(40), body: { accountId: 'org:acme', userId: 'bob' } })
    expect(removed.body.readerKeysRevoked).toBe(1)
    // A token minted after removal (stale org claim) still gets nothing: key revoked, wrapped key gone.
    t.h.advance(1000)
    const again = await t.read(t.bob, bobs.id)
    expect(again.status).not.toBe(200)
    expect(t.h.raw.prepare('SELECT key_id FROM read_snapshot_keys WHERE key_id = ?').all(bobs.id)).toEqual([])
    // Next sleep is not sealed to him either.
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/resume`)
    await t.sleep()
    expect(t.h.raw.prepare('SELECT key_id FROM read_snapshot_keys WHERE key_id = ?').all(bobs.id)).toEqual([])
  })

  it('a device added after the last sleep gets not_sealed_for_key; no snapshot yet is no_snapshot', async () => {
    const t = await setup()
    const first = await t.register(t.alice)
    expect((await t.read(t.alice, first.id)).body).toEqual({ error: 'no_snapshot' })
    await t.sleep()
    const later = await t.register(t.alice)
    expect((await t.read(t.alice, later.id)).body).toEqual({ error: 'not_sealed_for_key' })
    expect((await t.read(t.alice, 'rk_nope')).status).toBe(400)
  })

  it('registration is idempotent, per member capped, and a key revoke drops its wrapped key', async () => {
    const t = await setup()
    const key = generateGrantRecipientKey()
    const body = { publicKeyB64: key.publicKeyB64, deviceLabel: 'Mac', deviceKind: 'desktop' }
    const a = await t.req(t.alice, 'PUT', '/v1/reader-keys', body)
    const b = await t.req(t.alice, 'PUT', '/v1/reader-keys', body)
    expect(a.body.readerKey.id).toBe(b.body.readerKey.id)
    expect((await t.req(t.alice, 'PUT', '/v1/reader-keys', { ...body, publicKeyB64: 'AAAA' })).status).toBe(400)
    await t.sleep()
    expect((await t.read(t.alice, a.body.readerKey.id)).status).toBe(200)
    expect((await t.req(t.bob, 'DELETE', `/v1/reader-keys/${a.body.readerKey.id}`)).status).toBe(404)
    expect((await t.req(t.alice, 'DELETE', `/v1/reader-keys/${a.body.readerKey.id}`)).body).toEqual({ ok: true })
    expect((await t.read(t.alice, a.body.readerKey.id)).status).toBe(400)
    // Re-registering a revoked key yields a new id (never resurrected), with nothing sealed to it.
    const c = await t.req(t.alice, 'PUT', '/v1/reader-keys', body)
    expect(c.body.readerKey.id).not.toBe(a.body.readerKey.id)
    for (let i = 0; i < 14; i++) {
      await t.register(t.alice)
    }
    expect((await t.req(t.alice, 'GET', '/v1/reader-keys')).body.readerKeys).toHaveLength(12)
  })

  it('a phone key dies with its device session', async () => {
    const t = await setup()
    const { privateKey, publicKey } = await generateKeyPair('Ed25519', { extractable: true })
    const publicKeyB64 = Buffer.from((await exportJWK(publicKey)).x!, 'base64url').toString('base64')
    const enrolled = await t.h.call('POST', '/v1/device-sessions', {
      body: { label: 'iPhone', platform: 'ios', publicKeyB64 },
      bearer: await t.h.token('alice', 'acme', 'sandbox', { org_role: 'member' })
    })
    const sessionId = enrolled.body.deviceSession.id as string
    const phoneToken = async () => {
      const iat = Math.floor(t.h.now() / 1000)
      return new SignJWT({}).setProtectedHeader({ alg: 'EdDSA', kid: sessionId }).setIssuer('orca-device').setSubject(sessionId)
        .setAudience('orca-sandbox').setIssuedAt(iat).setExpirationTime(iat + 120).sign(privateKey)
    }
    const key = await t.register(t.alice, 'mobile', await phoneToken())
    await t.sleep()
    const res = await t.read(t.alice, key.id, await phoneToken())
    expect(res.status).toBe(200)
    expect((await t.open(res.body, key.secretKey)).sessions[0]!.messages[1]!.text).toBe(SECRET_LINE)
    await t.h.call('DELETE', `/v1/device-sessions/${sessionId}`, { bearer: await t.h.token('alice', 'acme') })
    expect(t.h.raw.prepare('SELECT revoked_by FROM reader_keys WHERE id = ?').get(key.id)).toEqual({ revoked_by: 'system:device_revoked' })
    expect(t.h.raw.prepare('SELECT * FROM read_snapshot_keys WHERE key_id = ?').all(key.id)).toEqual([])
  })

  it('a failed capture keeps the previous snapshot and never blocks the sleep', async () => {
    const t = await setup()
    const key = await t.register(t.alice)
    await t.sleep()
    const first = (await t.read(t.alice, key.id)).body.snapshot.snapshotId
    await t.req(t.alice, 'POST', `/v1/sandboxes/${t.id}/resume`)
    // The VM script finds no orcad (exit 3).
    expect((await t.sleep(t.alice, true)).status).toBe(200)
    expect((await t.read(t.alice, key.id)).body.snapshot.snapshotId).toBe(first)
  })

  it('the VM sealer bounds what it seals and caps recipients', () => {
    const big = {
      v: 1,
      sessions: Array.from({ length: 3 }, (_, i) => ({ sessionId: `s${i}`, messages: Array.from({ length: 60 }, (_, j) => ({ itemId: `${j}`, role: 'user', text: 'x'.repeat(4000), at: j })) })),
      git: { changes: [] }
    }
    const fitted = vm.fitToBudget(big, 150_000)
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(150_000)
    expect(MAX_READ_RECIPIENTS).toBe(64)
    // A malformed recipient is skipped, not fatal.
    const out = vm.seal({ v: 1 }, [{ keyId: 'rk_bad', publicKeyB64: 'x' }, { keyId: 'rk_000000000000000000000000', publicKeyB64: generateGrantRecipientKey().publicKeyB64 }], 'sbx_0', 'rsn_0') as { recipients: unknown[] }
    expect(out.recipients).toHaveLength(1)
  })

  it('lists chats from orcad’s session store (read-only), open tabs and last turns included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-'))
    const db = new DatabaseSync(join(dir, 'agent-session-journal.db'))
    db.exec('CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL); CREATE TABLE agent_session_tabs (tab_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL)')
    const record = { provider: 'claude', conversationName: 'Gap5 live check', updatedAt: 5, lastTurn: { state: 'settled', outcome: 'success', prompt: 'What is this repo?', reply: 'Hello World!', at: 4 } }
    db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('claude_1', JSON.stringify(record))
    db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('broken', '{not json')
    db.prepare('INSERT INTO agent_session_tabs VALUES (?, ?, 0)').run('structured-agent-session-claude_1', 'claude_1')
    db.close()
    expect(vm.storedSessions(dir)).toEqual([
      expect.objectContaining({ sessionId: 'claude_1', agent: 'claude', title: 'Gap5 live check', status: 'idle', turnOutcome: 'success', open: true, lastPrompt: 'What is this repo?', lastReply: 'Hello World!' })
    ])
    expect(vm.storedSessions(join(dir, 'missing'))).toEqual([])
  })

  it('the VM signs every snapshot; a forged or swapped one fails, and a device keeps the signer it pinned', async () => {
    const t = await setup()
    const key = await t.register(t.alice)
    await t.sleep()
    const sealed = (await t.read(t.alice, key.id)).body.snapshot
    const signer = await verifyReadSnapshotSigner(sealed, ed25519Verify)
    expect(signer).toBe(vm.signingKey(VM_STATE).publicKeyB64)
    // The control plane can seal anything to a reader key, but it can't sign as the VM.
    const forged = { ...sealed, ciphertextB64: Buffer.from(Buffer.from(sealed.ciphertextB64, 'base64').map((b: number, i: number) => (i === 0 ? b ^ 1 : b))).toString('base64') }
    await expect(verifyReadSnapshotSigner(forged, ed25519Verify)).rejects.toThrow('bad_signature')
    const otherVm = vm.signingKey(mkdtempSync(join(tmpdir(), 'other-vm-')))
    const resigned = { ...forged, signature: vm.sign(forged, otherVm) }
    const other = await verifyReadSnapshotSigner(resigned, ed25519Verify)
    const snap = await t.open({ snapshot: sealed } as never, key.secretKey)
    const first = checkReadSnapshotPin(null, signer, snap.capturedAt)
    expect(first.ok).toBe(true)
    const pin = first.ok ? first.pin : null
    expect(checkReadSnapshotPin(pin, other, snap.capturedAt + 1)).toEqual({ ok: false, reason: 'signer_changed' })
    expect(checkReadSnapshotPin(pin, null, snap.capturedAt + 1)).toEqual({ ok: false, reason: 'unsigned' })
    expect(checkReadSnapshotPin(pin, signer, snap.capturedAt - 1)).toEqual({ ok: false, reason: 'rollback' })
    // D1 relays the signature it was given, nothing more.
    expect(t.h.raw.prepare('SELECT signature FROM read_snapshots').get()).toEqual({ signature: JSON.stringify(sealed.signature) })
  })

  it('the VM signing key survives a broken file and refuses a relative state dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-sandbox-'))
    const first = vm.signingKey(dir).publicKeyB64
    expect(vm.signingKey(dir).publicKeyB64).toBe(first)
    writeFileSync(join(dir, 'read-signing-key.pem'), '')
    const replaced = vm.signingKey(dir).publicKeyB64
    expect(replaced).not.toBe(first)
    expect(vm.signingKey(dir).publicKeyB64).toBe(replaced)
    expect(() => vm.signingKey('.orca-sandbox')).toThrow()
  })

  it('reads the workspace’s own checkout, not the base clone (branch workspaces are separate worktrees)', () => {
    const base = { path: '/vercel/sandbox/project', isMainWorktree: true, lastActivityAt: 0, sortOrder: 5 }
    const branch = { path: '/vercel/sandbox/worktrees/ra10-asleep', isMainWorktree: false, lastActivityAt: 0, sortOrder: 9 }
    // No chats: the most recently active checkout.
    expect(vm.workspaceCheckout([base, branch], [])).toBe(branch)
    // Chats: the checkout the newest one works in wins.
    expect(vm.workspaceCheckout([base, branch], [{ worktreePath: base.path, updatedAt: 2 }, { worktreePath: branch.path, updatedAt: 1 }])).toBe(base)
    // A tie prefers the workspace's worktree over the base clone.
    expect(vm.workspaceCheckout([{ ...base, sortOrder: 9 }, branch], [])).toBe(branch)
    expect(vm.workspaceCheckout([], [])).toBeNull()
  })
})
