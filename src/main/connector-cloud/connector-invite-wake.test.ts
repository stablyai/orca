// The invite wake through the real wiring: the sign-in refresh's wake token, the share list read with
// the sign-in token, the socket it offers, and the share list's idle read stopping while it is up.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import type { OrcaCloudAuthConfig } from '../orca-profiles/cloud-auth/profile-cloud-auth-config'
import { linkOrcaProfileToCloud } from '../orca-profiles/cloud-auth/profile-cloud-index'
import { signInCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-owner'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  knownHostInstallationId,
  loadOrCreateHostInstallationId
} from '../runtime/hosts/platform-probe/host-descriptor'
import { exchangeOrcaCloudAuthCode } from '../orca-profiles/cloud-auth/profile-cloud-client'
import { beginCloudConnectAttempt } from '../orca-profiles/cloud-auth/profile-cloud-connect-attempts'
import { commitExchangedCloudSession } from '../orca-profiles/cloud-session/profile-cloud-session-commit'
import { SharedBotHosts } from '../bots/shared-with-me/shared-bot-hosts'
import { sharedBotsCloud } from '../bots/shared-with-me/shared-bots-cloud'
import { ConnectorCloud } from './connector-cloud'
import { desktopConnectorCredentials } from './connector-token-mint'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'
import { FakeWakeSockets } from './fake-wake-socket.test-fixture'

const NOW = 1_800_000_000_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const AUTH = 'https://auth.test'
const WAKE_URL = 'wss://wake.test/v1/connector/wake'
const MINE = `${CONNECTOR_PATHS.shares}/mine`
const config: OrcaCloudAuthConfig = {
  apiBaseUrl: AUTH,
  authorizeEndpoint: `${AUTH}/authorize`,
  sessionEndpoint: `${AUTH}/session`,
  refreshEndpoint: `${AUTH}/refresh`,
  capabilitiesEndpoint: `${AUTH}/capabilities`,
  profileEndpoint: `${AUTH}/profile`,
  orgEndpoint: `${AUTH}/org`,
  logoutEndpoint: `${AUTH}/logout`,
  relayTokenEndpoint: `${AUTH}/relay-token`,
  connectorTokenEndpoint: `${AUTH}/connector-token`,
  relayDirectorUrl: AUTH,
  clientId: 'client-1',
  scope: 'openid'
}
const cloudSummary = { userId: 'ada', cloudProfileId: 'cp-ada', email: 'ada@example.test' }

const RequestBody = z.record(z.string(), z.unknown())

let userDataPath = ''
let fake: FakeConnectorCloud
let wake: FakeWakeSockets
// What the auth service and the connector's shares route do and saw.
let cloud: {
  issuesWakeTokens: boolean
  // The rollout's switch: off, a sign-in read carries no wake URL.
  sendsWakeUrl: boolean
  refreshes: Record<string, unknown>[]
  signIns: Record<string, unknown>[]
  mineReads: { token: string | null; machineId: string | null }[]
}

const fetchImpl: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.origin === AUTH && url.pathname === '/refresh') {
    const body = RequestBody.parse(JSON.parse(String(init?.body)))
    cloud.refreshes.push(body)
    const n = cloud.refreshes.length
    return Response.json({
      accessToken: `access-${n}`,
      refreshToken: `refresh-${n}`,
      expiresAt: Date.now() + HOUR_MS,
      cloud: cloudSummary,
      capabilities: { flags: {}, refreshedAt: 1 },
      ...(cloud.issuesWakeTokens && body.machineId
        ? { wakeToken: { token: `wake-${n}`, expiresAt: Date.now() + HOUR_MS + 15 * MINUTE_MS } }
        : {})
    })
  }
  if (url.origin === AUTH && url.pathname === '/session') {
    const body = RequestBody.parse(JSON.parse(String(init?.body)))
    cloud.signIns.push(body)
    return Response.json({
      accessToken: 'access-signin',
      refreshToken: 'refresh-signin',
      expiresAt: Date.now() + HOUR_MS,
      cloud: cloudSummary,
      capabilities: { flags: {}, refreshedAt: 1 },
      ...(cloud.issuesWakeTokens && body.machineId
        ? { wakeToken: { token: 'wake-signin', expiresAt: Date.now() + HOUR_MS + 15 * MINUTE_MS } }
        : {})
    })
  }
  if (url.pathname === MINE) {
    const headers = new Headers(init?.headers)
    const token = headers.get('authorization')?.slice('Bearer '.length) ?? null
    cloud.mineReads.push({ token, machineId: headers.get('x-orca-machine-id') })
    // The wake URL rides only on a read made with the sign-in token, as the rollout sends it.
    const signIn = token?.startsWith('access-') === true
    return Response.json(
      { v: 1, shares: [] },
      {
        headers:
          signIn && cloud.issuesWakeTokens && cloud.sendsWakeUrl
            ? { 'x-orca-wake-url': WAKE_URL }
            : {}
      }
    )
  }
  return fake.fetch(input, init)
}

// Each step lets fetches, session writes and timers run to the next one.
const settle = async (ms = 0): Promise<void> => {
  for (let step = 0; step < 50; step++) {
    await vi.advanceTimersByTimeAsync(ms / 50)
  }
}

function setUp(options: { connector: boolean; connectNow?: boolean }) {
  const seam = fakeSeam()
  const machine = fakeMachine(() => seam)
  machine.wanted = options.connector
  const quit = { fenced: false }
  const connector = new ConnectorCloud({
    userDataPath,
    origin: fake.origin,
    machine,
    account: () => 'ada',
    isFenced: () => quit.fenced,
    mintFor: (account) => fake.mintFor(account),
    fetchImpl,
    signIn: desktopConnectorCredentials(config, userDataPath).signIn,
    wakeSocketFactory: wake.factory
  })
  if (options.connectNow !== false) {
    connector.connect()
  }
  const hosts = new SharedBotHosts({
    userDataPath,
    cloud: () => sharedBotsCloud(connector),
    account: () => connector.signedInAccount(),
    publish: () => {},
    invites: connector.invites,
    random: () => 0
  })
  return { connector, hosts, machine, quit }
}

const reads = () => cloud.mineReads.length
const inviteSockets = () => wake.dialed.filter((socket) => socket.url === WAKE_URL)

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: NOW
  })
  vi.stubGlobal('fetch', fetchImpl)
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-invite-wake-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (cipher) => cipher.toString().slice('sealed:'.length),
    describeProtectionGap: () => null,
    describeSealing: () => ({ kind: 'os-keychain' })
  })
  fake = new FakeConnectorCloud()
  wake = new FakeWakeSockets()
  cloud = { issuesWakeTokens: true, sendsWakeUrl: true, refreshes: [], signIns: [], mineReads: [] }
  // Signed in before this build: a session with no wake token, about to expire.
  const profileId = ensureActiveOrcaProfile(userDataPath).profile.id
  signInCloudSession(profileId, userDataPath, {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: NOW + 30_000,
    capabilities: { flags: {}, refreshedAt: 1 },
    cloud: { ...cloudSummary, linkedAt: 1 }
  })
  linkOrcaProfileToCloud(profileId, { ...cloudSummary, linkedAt: 1 }, userDataPath)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('the invite wake on a desktop with no connector', () => {
  it('dials with the refresh’s wake token, reads on a share change, and polls only while it is down', async () => {
    const { hosts } = setUp({ connector: false })
    const machineId = await loadOrCreateHostInstallationId(userDataPath)
    hosts.start()
    await vi.waitFor(() => expect(inviteSockets()).toHaveLength(1))

    // The due refresh sent this install's id and its wake token opened the socket; the share list
    // was read with the sign-in token, never a connector token.
    expect(cloud.refreshes).toEqual([{ refreshToken: 'refresh-0', machineId }])
    expect(cloud.mineReads).toEqual([{ token: 'access-1', machineId }])
    expect(fake.mintAttempts).toBe(0)
    expect(inviteSockets()[0].headers.authorization).toBe('Bearer wake-1')

    // Open: no catch-up read (the list was just read) and no idle read, however long it stays up.
    inviteSockets()[0].accept()
    await settle(30 * MINUTE_MS)
    expect(reads()).toBe(1)

    // A share change is read at once (no spread with this random).
    inviteSockets()[0].emit('message', Buffer.from('{"type":"shares_changed"}'))
    await vi.waitFor(() => expect(reads()).toBe(2))
    expect(fake.mintAttempts).toBe(0)

    // It drops and its redial never opens: the idle read comes back.
    inviteSockets()[0].end(1006)
    await settle(10 * MINUTE_MS + 1_000)
    await vi.waitFor(() => expect(reads()).toBe(3))

    // Back up within ten minutes of that read: no catch-up read, and the idle read stops again.
    const redialed = inviteSockets().at(-1)
    expect(redialed && redialed !== inviteSockets()[0]).toBe(true)
    redialed?.accept()
    await settle(30 * MINUTE_MS)
    expect(reads()).toBe(3)

    // A drop after a long quiet spell (a reconnect wave): one catch-up read once it reopens.
    redialed?.end(1006)
    await settle(2_000)
    inviteSockets().at(-1)?.accept()
    await vi.waitFor(() => expect(reads()).toBe(4))
    await settle(30 * MINUTE_MS)
    expect(reads()).toBe(4)
    hosts.stop()
  })

  it('dials right after a sign-in with the wake token the sign-in returned, with no refresh', async () => {
    const machineId = await loadOrCreateHostInstallationId(userDataPath)
    const profileId = ensureActiveOrcaProfile(userDataPath).profile.id
    const exchange = await exchangeOrcaCloudAuthCode(config, {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      nonce: 'nonce-1',
      redirectUri: 'http://127.0.0.1/callback',
      state: 'state-1',
      localProfileId: profileId,
      machineId: knownHostInstallationId(userDataPath)
    })
    await expect(
      commitExchangedCloudSession({
        config,
        profileId,
        userDataPath,
        attempt: beginCloudConnectAttempt(),
        exchange,
        guards: {}
      })
    ).resolves.toMatchObject({ status: 'committed' })
    expect(cloud.signIns[0]).toMatchObject({ machineId })

    // The sign-in hook reads the share list, as after a refresh.
    const { hosts } = setUp({ connector: false })
    hosts.start()
    await vi.waitFor(() => expect(inviteSockets()).toHaveLength(1))
    expect(inviteSockets()[0].headers.authorization).toBe('Bearer wake-signin')
    expect(cloud.mineReads).toEqual([{ token: 'access-signin', machineId }])
    expect(cloud.refreshes).toHaveLength(0)
    expect(fake.mintAttempts).toBe(0)
    hosts.stop()
  })

  it('opens nothing and polls as before when the auth service issues no wake token', async () => {
    cloud.issuesWakeTokens = false
    const { hosts } = setUp({ connector: false })
    hosts.start()
    await vi.waitFor(() => expect(reads()).toBe(1))
    // Read with a connector token, as before.
    expect(cloud.mineReads[0].token).not.toMatch(/^access-/)
    await settle(10 * MINUTE_MS + 1_000)
    await vi.waitFor(() => expect(reads()).toBe(2))
    expect(wake.dialed).toHaveLength(0)
    hosts.stop()
  })
})

/** A desktop with no connector whose invite socket is open after its first read. */
async function upAndRead() {
  const setup = setUp({ connector: false })
  setup.hosts.start()
  await vi.waitFor(() => expect(inviteSockets()).toHaveLength(1))
  inviteSockets()[0].accept()
  await settle()
  expect(setup.connector.invites.up).toBe(true)
  return setup
}

describe('the invite socket closing', () => {
  it('closes when Orca quits, and never redials', async () => {
    const { connector, hosts, quit } = await upAndRead()
    quit.fenced = true
    connector.fence()
    expect(inviteSockets()[0].closed).toBe(true)
    expect(connector.invites.up).toBe(false)
    await settle(2 * MINUTE_MS)
    expect(inviteSockets()).toHaveLength(1)
    hosts.stop()
  })

  it('closes once a read says the rollout no longer sends a wake URL', async () => {
    const { connector, hosts } = await upAndRead()
    cloud.sendsWakeUrl = false
    void hosts.refresh()
    await vi.waitFor(() => expect(inviteSockets()[0].closed).toBe(true))
    expect(connector.invites.up).toBe(false)
    hosts.stop()
  })

  it('reads on a plain wake frame too', async () => {
    const { hosts } = await upAndRead()
    inviteSockets()[0].wake()
    await vi.waitFor(() => expect(reads()).toBe(2))
    hosts.stop()
  })

  it('closes when a connector starts, and opens again once it stops', async () => {
    fake.signedIn.add('ada')
    const { connector, hosts, machine } = await upAndRead()
    machine.wanted = true
    machine.inputsChanged()
    await settle()
    expect(inviteSockets()[0].closed).toBe(true)
    expect(connector.invites.up).toBe(false)
    machine.wanted = false
    machine.inputsChanged()
    await settle(MINUTE_MS)
    void hosts.refresh()
    await vi.waitFor(() => expect(inviteSockets()).toHaveLength(2))
    hosts.stop()
  })
})

describe('a desktop with a connector', () => {
  it('never dials the invite socket from a read made before the connector connects', async () => {
    fake.signedIn.add('ada')
    const { connector, hosts } = setUp({ connector: true, connectNow: false })
    hosts.start()
    await vi.waitFor(() => expect(reads()).toBe(1))
    connector.connect()
    await settle()
    expect(cloud.mineReads[0].token).not.toMatch(/^access-/)
    expect(inviteSockets()).toHaveLength(0)
    hosts.stop()
  })

  it('keeps its own socket and connector-token reads, and reads on a share change it hears', async () => {
    fake.signedIn.add('ada')
    fake.wakeOffer = {
      wakeUrl: 'wss://connector-wake.test/v1/connector/wake',
      safetyPollMs: 180_000
    }
    fake.mintsWakeTokens = true
    const { connector, hosts } = setUp({ connector: true })
    await settle()
    hosts.start()
    await vi.waitFor(() => expect(reads()).toBe(1))
    expect(cloud.mineReads[0].token).not.toMatch(/^access-/)
    const connectorSocket = wake.dialed.find((socket) => socket.url !== WAKE_URL)
    expect(connectorSocket).toBeDefined()
    expect(inviteSockets()).toHaveLength(0)
    connectorSocket?.accept()
    await settle()
    connectorSocket?.emit('message', Buffer.from('{"type":"shares_changed"}'))
    await vi.waitFor(() => expect(reads()).toBe(2))
    // Its idle read is as before: the invite wake never opened.
    expect(connector.invites.up).toBe(false)
    await settle(10 * MINUTE_MS + 1_000)
    await vi.waitFor(() => expect(reads()).toBe(3))
    expect(inviteSockets()).toHaveLength(0)
    hosts.stop()
  })
})
