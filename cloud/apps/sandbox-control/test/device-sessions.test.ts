import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createHarness } from './harness'

async function deviceKey() {
  const { privateKey, publicKey } = await generateKeyPair('Ed25519', { extractable: true })
  const x = (await exportJWK(publicKey)).x!
  const publicKeyB64 = Buffer.from(x, 'base64url').toString('base64')
  return { privateKey, publicKeyB64 }
}

async function setup() {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const h = await createHarness()
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
})
