import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import { ConnectorCloud, type ConnectorSignInPrompt } from './connector-cloud'
import { readConnectorHostIdentity } from './connector-host-identity'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'

let userDataPath: string
let fake: FakeConnectorCloud
let enabled: boolean

function connectorCloud(): ConnectorCloud {
  return new ConnectorCloud({
    userDataPath,
    origin: fake.origin,
    runtime: 'serve',
    orcaVersion: '1.4.250',
    connectorsEnabled: () => enabled,
    fetchImpl: fake.fetch
  })
}

/** Runs finishSignIn while fake time passes each poll interval. */
async function finish(cloud: ConnectorCloud, prompt: ConnectorSignInPrompt, signal?: AbortSignal) {
  const settled = cloud.finishSignIn(prompt.flowId, signal).then(
    (link) => ({ ok: true as const, link }),
    (error: Error) => ({ ok: false as const, message: error.message })
  )
  for (let step = 0; step < 20; step++) {
    await vi.advanceTimersByTimeAsync(1_000)
  }
  return settled
}

beforeEach(() => {
  vi.useFakeTimers()
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-cloud-'))
  fake = new FakeConnectorCloud()
  enabled = true
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorCloud sign-in', () => {
  it('refuses while connectors are off, before asking the cloud', async () => {
    enabled = false
    await expect(connectorCloud().beginSignIn()).rejects.toThrow('connectors_disabled')
    expect(fake.requests).toEqual([])
  })

  it('links a fresh key once the person approves, honouring slow_down', async () => {
    fake.signInAnswers = [
      { status: 'pending' },
      { status: 'slow_down', interval: 2 },
      { status: 'authorized', email: 'ada@example.com' }
    ]
    const cloud = connectorCloud()
    const prompt = await cloud.beginSignIn('build-box')
    expect(prompt).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: `${fake.origin}/host-login`
    })
    expect(fake.requestsTo(CONNECTOR_PATHS.signInStart)[0]?.body).toMatchObject({
      v: 1,
      hostName: 'build-box',
      runtime: 'serve',
      orcaVersion: '1.4.250'
    })

    const result = await finish(cloud, prompt)

    expect(result).toMatchObject({
      ok: true,
      link: { email: 'ada@example.com', hostName: 'build-box' }
    })
    expect(fake.requestsTo(CONNECTOR_PATHS.signInPoll)).toHaveLength(3)
    const identity = readConnectorHostIdentity(userDataPath)
    expect(identity?.keypair.publicKeyB64).toBe(fake.signInPublicKeyB64)
    expect(cloud.status()).toEqual({ enabled: true, link: identity?.link })
    await expect(cloud.beginSignIn()).rejects.toThrow('Already connected as ada@example.com')
  })

  it('keeps polling through an outage; the poll carries no secret to lose', async () => {
    fake.signInAnswers = [{ status: 'authorized', email: 'ada@example.com' }]
    const cloud = connectorCloud()
    const prompt = await cloud.beginSignIn()
    fake.online = false
    setTimeout(() => {
      fake.online = true
    }, 3_500)
    expect(await finish(cloud, prompt)).toMatchObject({ ok: true })
  })

  it.each([
    ['denied', 'Sign-in was denied.'],
    ['expired', 'Sign-in expired.']
  ] as const)('reports %s and keeps no key', async (status, message) => {
    fake.signInAnswers = [{ status }]
    const cloud = connectorCloud()
    const result = await finish(cloud, await cloud.beginSignIn())
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(message) })
    expect(readConnectorHostIdentity(userDataPath)).toBeNull()
  })

  it('refuses an approval that names a different key', async () => {
    fake.signInAnswers = [
      { status: 'authorized', email: 'ada@example.com', hostId: 'someone-else' }
    ]
    const cloud = connectorCloud()
    const result = await finish(cloud, await cloud.beginSignIn())
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('different machine key')
    })
    expect(readConnectorHostIdentity(userDataPath)).toBeNull()
  })

  it('ends a sign-in when its caller goes away or a newer one starts', async () => {
    const cloud = connectorCloud()
    const gone = new AbortController()
    const first = await cloud.beginSignIn()
    const waiting = finish(cloud, first, gone.signal)
    gone.abort()
    expect(await waiting).toEqual({ ok: false, message: 'Sign-in was cancelled.' })

    const older = await cloud.beginSignIn()
    const olderWaiting = finish(cloud, older)
    await cloud.beginSignIn()
    expect(await olderWaiting).toEqual({ ok: false, message: 'Sign-in was cancelled.' })
    await expect(cloud.finishSignIn(older.flowId)).rejects.toThrow('no longer running')
  })

  it('lets nothing retired link a key: a logout, a disable, or a login that finished first', async () => {
    fake.signInAnswers = [{ status: 'authorized', email: 'ada@example.com' }]
    const cloud = connectorCloud()
    const loggedOut = finish(cloud, await cloud.beginSignIn())
    expect(await cloud.signOut()).toEqual({ signedOut: false })
    expect(await loggedOut).toEqual({ ok: false, message: 'Sign-in was cancelled.' })

    const disabled = finish(cloud, await cloud.beginSignIn())
    enabled = false
    expect(await disabled).toEqual({ ok: false, message: 'connectors_disabled' })
    enabled = true

    const other = connectorCloud()
    const first = await cloud.beginSignIn()
    const second = await other.beginSignIn()
    expect(await finish(other, second)).toMatchObject({ ok: true })
    expect(await finish(cloud, first)).toMatchObject({
      ok: false,
      message: expect.stringContaining('Already connected')
    })
    expect(readConnectorHostIdentity(userDataPath)?.link.hostId).toBe(other.status().link?.hostId)
  })

  it('a delayed logout never deletes the key of a login that finished meanwhile', async () => {
    fake.signInAnswers = [{ status: 'authorized', email: 'ada@example.com' }]
    const cloud = connectorCloud()
    await finish(cloud, await cloud.beginSignIn())
    fake.hang = true
    const delayed = cloud.signOut()
    await vi.advanceTimersByTimeAsync(0)
    fake.hang = false
    const other = connectorCloud()
    expect(await other.signOut()).toEqual({ signedOut: true })
    await finish(other, await other.beginSignIn())
    const fresh = other.status().link?.hostId
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await delayed).toEqual({ signedOut: true })
    expect(readConnectorHostIdentity(userDataPath)?.link.hostId).toBe(fresh)
  })

  it('names an older cloud without sign-in, and an unreachable one', async () => {
    fake.forced.set(CONNECTOR_PATHS.signInStart, { status: 404, body: { error: 'not_found' } })
    await expect(connectorCloud().beginSignIn()).rejects.toThrow(
      'This Orca Cloud does not support server sign-in yet.'
    )
    fake.online = false
    await expect(connectorCloud().beginSignIn()).rejects.toThrow('Could not reach Orca Cloud.')
  })
})

describe('ConnectorCloud sign-out', () => {
  async function signIn(cloud: ConnectorCloud): Promise<void> {
    fake.signInAnswers = [{ status: 'authorized', email: 'ada@example.com' }]
    expect(await finish(cloud, await cloud.beginSignIn())).toMatchObject({ ok: true })
  }

  it('proves the key with the connector handshake, unlinks, and forgets it', async () => {
    const cloud = connectorCloud()
    await signIn(cloud)
    const hostId = readConnectorHostIdentity(userDataPath)!.link.hostId

    expect(await cloud.signOut()).toEqual({ signedOut: true })

    expect(fake.linked.has(hostId)).toBe(false)
    const [unbind] = fake.requestsTo(CONNECTOR_PATHS.signOut)
    expect(unbind?.token).toBeTruthy()
    expect(fake.sessionHost(unbind!.token)).toBe(hostId)
    expect(cloud.status().link).toBeNull()
    expect(await cloud.signOut()).toEqual({ signedOut: false })
  })

  it('forgets the key even when the cloud cannot be reached', async () => {
    const cloud = connectorCloud()
    await signIn(cloud)
    fake.online = false
    expect(await cloud.signOut()).toEqual({ signedOut: true })
    expect(readConnectorHostIdentity(userDataPath)).toBeNull()
  })
})

describe('host identity file', () => {
  it('reads a file this version did not write as signed out', () => {
    writeFileSync(join(userDataPath, 'orca-cloud-host-key.json'), '{"v":2}')
    expect(readConnectorHostIdentity(userDataPath)).toBeNull()
    writeFileSync(join(userDataPath, 'orca-cloud-host-key.json'), 'not json')
    expect(readConnectorHostIdentity(userDataPath)).toBeNull()
  })

  it('stores only the secret key next to the link', async () => {
    fake.signInAnswers = [{ status: 'authorized', email: 'ada@example.com' }]
    const cloud = connectorCloud()
    await finish(cloud, await cloud.beginSignIn('box'))
    const stored = JSON.parse(readFileSync(join(userDataPath, 'orca-cloud-host-key.json'), 'utf-8'))
    expect(Object.keys(stored).sort()).toEqual(
      ['email', 'hostId', 'hostName', 'linkedAt', 'secretKeyB64', 'v'].sort()
    )
  })
})
