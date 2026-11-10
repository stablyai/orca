import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { generateGrantRecipientKey } from '../../../../src/main/cloud-workspaces/sealed-grant-node'
import { createHarness } from './harness'

async function deviceKey() {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519', { extractable: true })
  const x = (await exportJWK(publicKey)).x!
  const publicKeyB64 = Buffer.from(x, 'base64url').toString('base64')
  return { privateKey, publicKeyB64 }
}

const OP = 'o'.repeat(40)

async function setup() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const h = await createHarness({ OPERATOR_TOKEN: OP })
  const key = await deviceKey()
  const enroll = (bearer?: string, publicKeyB64 = key.publicKeyB64) =>
    h.call('POST', '/v1/device-sessions', { body: { label: 'Neil’s iPhone', platform: 'ios', publicKeyB64 }, bearer })
  const deviceToken = async (sessionId: string, privateKey = key.privateKey, opts: { iss?: string; ttl?: number } = {}) => {
    const iat = Math.floor(h.now() / 1000)
    return new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: sessionId })
      .setIssuer(opts.iss ?? 'orca-device')
      .setSubject(sessionId)
      .setAudience('orca-sandbox')
      .setIssuedAt(iat)
      .setExpirationTime(iat + (opts.ttl ?? 120))
      .sign(privateKey)
  }
  return { h, key, enroll, deviceToken }
}

describe('device sessions', () => {
  it('lets an enrolled phone act as its user until the session is revoked', async () => {
    const { h, enroll, deviceToken } = await setup()
    const enrolled = await enroll(await h.token('alice', 'acme', 'sandbox', { orgRole: 'member' }))
    expect(enrolled.status).toBe(200)
    const id = enrolled.body.deviceSession.id
    expect(id).toMatch(/^ds_/)

    const desktopCreate = await h.call('POST', '/v1/sandboxes', {
      body: { workspaceId: 'ws-1', machineSize: 'standard' },
      bearer: await h.token('alice', 'acme')
    })
    expect(desktopCreate.status).toBe(200)

    const phone = await deviceToken(id)
    const list = await h.call('GET', '/v1/sandboxes', { bearer: phone })
    expect(list.status).toBe(200)
    expect(list.body.sandboxes.map((s: { workspaceId: string }) => s.workspaceId)).toEqual(['ws-1'])

    const sessions = await h.call('GET', '/v1/device-sessions', { bearer: phone })
    expect(sessions.body.deviceSessions).toEqual([expect.objectContaining({ id, label: 'Neil’s iPhone', platform: 'ios', current: true })])

    const revoked = await h.call('DELETE', `/v1/device-sessions/${id}`, { bearer: await h.token('alice', 'acme') })
    expect(revoked.status).toBe(200)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id) })).status).toBe(401)
  })

  it('refuses phones for enrollment, secrets and GitHub connect', async () => {
    const { h, enroll, deviceToken } = await setup()
    const id = (await enroll(await h.token('alice'))).body.deviceSession.id
    const phone = await deviceToken(id)
    const other = await (await import('jose')).generateKeyPair('Ed25519', { extractable: true })
    const otherB64 = Buffer.from((await exportJWK(other.publicKey)).x!, 'base64url').toString('base64')
    expect((await enroll(phone, otherB64)).status).toBe(403)
    expect((await h.call('GET', '/v1/secrets', { bearer: phone })).status).toBe(403)
    expect((await h.call('POST', '/v1/github/connect', { bearer: phone })).status).toBe(403)
    // A long-lived API key would outlive the phone's revocation.
    expect((await h.call('POST', '/v1/api-keys', { body: { name: 'k', scopes: ['workspaces:read'] }, bearer: phone })).status).toBe(403)
  })

  it('rejects forged, foreign-issuer and expired device tokens', async () => {
    const { h, enroll, deviceToken } = await setup()
    const id = (await enroll(await h.token('alice'))).body.deviceSession.id
    const impostor = await deviceKey()
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id, impostor.privateKey) })).status).toBe(401)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id, undefined, { iss: 'orca' }) })).status).toBe(401)
    const token = await deviceToken(id)
    h.advance(6 * 60_000)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: token })).status).toBe(401)
  })

  it('needs a desktop to re-vouch for the phone every 14 days, even while in use', async () => {
    const { h, enroll, deviceToken } = await setup()
    const id = (await enroll(await h.token('alice', 'acme'))).body.deviceSession.id
    for (let day = 0; day < 13; day++) {
      h.advance(24 * 60 * 60_000)
      expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id) })).status).toBe(200)
    }
    h.advance(2 * 24 * 60 * 60_000)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id) })).status).toBe(401)
  })

  it('keeps a revoked key revoked and revokes by the desktop pairing id', async () => {
    const { h, key, enroll, deviceToken } = await setup()
    const desktop = await h.token('alice')
    const id = (await h.call('POST', '/v1/device-sessions', {
      body: { label: 'p', platform: 'ios', publicKeyB64: key.publicKeyB64, pairedDeviceId: 'dev-123' },
      bearer: desktop
    })).body.deviceSession.id
    expect((await h.call('DELETE', '/v1/device-sessions?pairedDeviceId=dev-123', { bearer: desktop })).body).toEqual({ revoked: 1 })
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id) })).status).toBe(401)
    const again = await enroll(await h.token('alice'))
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('key_revoked')
  })

  it('expires a session after 30 idle days', async () => {
    const { h, enroll, deviceToken } = await setup()
    const id = (await enroll(await h.token('alice'))).body.deviceSession.id
    h.advance(31 * 24 * 60 * 60_000)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(id) })).status).toBe(401)
  })

  it('never moves a key between users and lets a device revoke only itself', async () => {
    const { h, enroll, deviceToken } = await setup()
    const id = (await enroll(await h.token('alice'))).body.deviceSession.id
    expect((await enroll(await h.token('mallory'))).status).toBe(409)
    expect((await h.call('DELETE', `/v1/device-sessions/${id}`, { bearer: await h.token('mallory') })).status).toBe(404)

    const second = await deviceKey()
    const secondId = (await enroll(await h.token('alice'), second.publicKeyB64)).body.deviceSession.id
    expect((await h.call('DELETE', `/v1/device-sessions/${secondId}`, { bearer: await deviceToken(id) })).status).toBe(403)
    expect((await h.call('DELETE', `/v1/device-sessions/${id}`, { bearer: await deviceToken(id) })).status).toBe(200)
  })

  it('re-enrolling the same key refreshes the identity instead of adding a device', async () => {
    const { h, enroll } = await setup()
    const first = (await enroll(await h.token('alice'))).body.deviceSession.id
    const again = (await enroll(await h.token('alice', 'acme', 'sandbox', { orgRole: 'admin' }))).body.deviceSession.id
    expect(again).toBe(first)
    const listed = await h.call('GET', '/v1/device-sessions', { bearer: await h.token('alice') })
    expect(listed.body.deviceSessions).toHaveLength(1)
  })

  it('revokes a removed member’s phones on either auth push, and only theirs', async () => {
    for (const path of ['/v1/internal/org-members/removed', '/v1/internal/members/removed']) {
      const { h, enroll, deviceToken } = await setup()
      const bob = await deviceKey()
      const aliceId = (await enroll(await h.token('alice', 'acme'))).body.deviceSession.id
      const bobId = (await enroll(await h.token('bob', 'acme'), bob.publicKeyB64)).body.deviceSession.id
      const removed = await h.call('POST', path, { bearer: OP, body: { accountId: 'org:acme', userId: 'bob' } })
      expect(removed.status).toBe(200)
      expect(removed.body.devicesRevoked).toBe(1)
      expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(bobId, bob.privateKey) })).status).toBe(401)
      expect((await h.call('GET', '/v1/sandboxes', { bearer: await deviceToken(aliceId) })).status).toBe(200)
    }
  })

  it('moves a phone with its member’s role, and a phone’s stored role never re-raises their keys', async () => {
    const { h, enroll, deviceToken } = await setup()
    const asAdmin = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
    const id = (await enroll(asAdmin)).body.deviceSession.id
    const { secret } = (await h.call('POST', '/v1/api-keys', { bearer: asAdmin, body: { name: 'audit', scopes: ['audit:read', 'workspaces:read'] } })).body
    expect((await h.call('GET', '/v1/me', { bearer: await deviceToken(id) })).body.role).toBe('admin')

    await h.call('POST', '/v1/internal/members/role-changed', { bearer: OP, body: { accountId: 'org:acme', userId: 'ada', role: 'member' } })
    expect((await h.call('GET', '/v1/me', { bearer: await deviceToken(id) })).body.role).toBe('member')
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(403)

    // Even a stale admin snapshot on the phone (a missed sync) must not hand the keys admin back.
    await h.env.SANDBOX_DB.prepare(`UPDATE device_sessions SET org_role = 'admin' WHERE id = ?`).bind(id).run()
    h.advance(61_000)
    await h.call('GET', '/v1/me', { bearer: await deviceToken(id) })
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(403)
  })

  it('an admin desktop token from before a demotion can neither re-raise the role nor re-vouch a phone', async () => {
    const { h, enroll, deviceToken } = await setup()
    const oldAdmin = await h.token('ada', 'acme', 'sandbox', { orgRole: 'admin' })
    const id = (await enroll(oldAdmin)).body.deviceSession.id
    const { secret } = (await h.call('POST', '/v1/api-keys', { bearer: oldAdmin, body: { name: 'audit', scopes: ['audit:read', 'workspaces:read'] } })).body
    h.advance(1_000)
    await h.call('POST', '/v1/internal/members/role-changed', { bearer: OP, body: { accountId: 'org:acme', userId: 'ada', role: 'member' } })
    h.advance(61_000)
    await h.call('GET', '/v1/me', { bearer: oldAdmin })
    expect((await h.call('GET', '/v1/audit', { bearer: secret })).status).toBe(403)
    expect((await enroll(oldAdmin)).status).toBe(403)
    expect((await h.call('GET', '/v1/me', { bearer: await deviceToken(id) })).body.role).toBe('member')
    // A token minted after the change carries the live role again.
    const fresh = await h.token('ada', 'acme', 'sandbox', { orgRole: 'member' })
    expect((await enroll(fresh)).status).toBe(200)
  })

  it('a desktop token from before a removal cannot enroll a new phone', async () => {
    const { h, enroll } = await setup()
    const old = await h.token('bob', 'acme')
    h.advance(1_000)
    await h.call('POST', '/v1/internal/members/removed', { bearer: OP, body: { accountId: 'org:acme', userId: 'bob' } })
    // The token no longer authenticates at all once its member is gone.
    expect((await enroll(old)).status).toBe(401)
  })

  it('either removal push also revokes the workspace devices a removed member’s phone was granted', async () => {
    for (const path of ['/v1/internal/org-members/removed', '/v1/internal/members/removed']) {
      const { h, enroll, deviceToken } = await setup()
      const alice = () => h.token('alice', 'acme', 'sandbox', { orgRole: 'member' })
      const sandbox = (await h.call('POST', '/v1/sandboxes', { body: { workspaceId: 'ws-1', machineSize: 'standard' }, bearer: await alice() })).body.sandbox
      await h.call('PATCH', `/v1/team/workspaces/${sandbox.id}`, { body: { visibility: 'team' }, bearer: await alice() })
      const bob = await deviceKey()
      const phone = (await enroll(await h.token('bob', 'acme'), bob.publicKeyB64)).body.deviceSession.id
      const granted = await h.call('POST', `/v1/team/workspaces/${sandbox.id}/grants`, {
        body: { recipientPublicKeyB64: generateGrantRecipientKey().publicKeyB64, deviceLabel: 'Bob’s iPhone', deviceKind: 'mobile' },
        bearer: await deviceToken(phone, bob.privateKey)
      })
      expect(granted.status).toBe(200)
      h.advance(1_000)
      const removed = await h.call('POST', path, { bearer: OP, body: { accountId: 'org:acme', userId: 'bob' } })
      expect(removed.body).toMatchObject({ devicesRevoked: 1, grantsRevoked: 1 })
      const box = [...h.vercel.boxes.values()][0]!
      expect(box.devices.some((d) => d.startsWith('dev-grant'))).toBe(false)
    }
  })

  it('a removed member’s unexpired desktop token stops working everywhere; a re-added member’s new one works', async () => {
    const { h } = await setup()
    const old = await h.token('bob', 'acme')
    expect((await h.call('GET', '/v1/sandboxes', { bearer: old })).status).toBe(200)
    h.advance(1_000)
    await h.call('POST', '/v1/internal/org-members/removed', { bearer: OP, body: { accountId: 'org:acme', userId: 'bob' } })
    expect((await h.call('GET', '/v1/sandboxes', { bearer: old })).status).toBe(401)
    expect((await h.call('POST', '/v1/api-keys', { bearer: old, body: { name: 'k', scopes: ['workspaces:read'] } })).status).toBe(401)
    // Their personal account is not the team's to close.
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await h.token('bob') })).status).toBe(200)
    h.advance(1_000)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await h.token('bob', 'acme') })).status).toBe(200)
  })

  it('counts a change from auth’s reported time, clamped to how long a token can live', async () => {
    const { h, enroll } = await setup()
    const start = h.now()
    await h.call('POST', '/v1/internal/members/role-changed', { bearer: OP, body: { accountId: 'org:acme', userId: 'ada', role: 'member', changedAt: start + 5_000 } })
    h.advance(3_000)
    // Minted before auth's change time (auth's clock ran ahead of ours): still stale.
    expect((await enroll(await h.token('ada', 'acme'))).status).toBe(403)
    h.advance(3_000)
    expect((await enroll(await h.token('ada', 'acme'))).status).toBe(200)
    await h.call('POST', '/v1/internal/members/removed', { bearer: OP, body: { accountId: 'org:acme', userId: 'cy', changedAt: h.now() + 24 * 60 * 60_000 } })
    h.advance(15 * 60_000 + 1_000)
    expect((await h.call('GET', '/v1/sandboxes', { bearer: await h.token('cy', 'acme') })).status).toBe(200)
  })
})
