// Contract replay: the shipped desktop and phone clients (their own request builders and strict
// response parsers, imported from the app sources) against the Worker's edge-native director
// answers, end to end through the router and a real host object.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RelayCredentialStore, hashCredential } from '../../relay/src/credentials/credential-store'
import { AssignmentResponseSchema, ResolveResponseSchema } from '../../../packages/relay-contract/src/director-messages'
import { RelayHttpError, requestRelayAssignment } from '../../../../src/main/runtime/mobile-cloud-relay/director/relay-http-client'
import { RelayAssignRateGate } from '../../../../src/main/runtime/mobile-cloud-relay/director/relay-assign-rate-gate'
import { fetchRelayRegionCatalog } from '../../../../src/main/runtime/mobile-cloud-relay/region-selection/relay-region-catalog-fetch'
import { resolveMobileRelayEndpoint } from '../../../../mobile/src/transport/relay/mobile-relay-resume-director'
import { resolvePairingInviteThroughDirector } from '../../../../mobile/src/pairing/mobile-relay-invite-director'
import { DIRECTOR_URL, DIRECTOR_VARS, EDGE_URL, FRONT_DOOR_URL, baseEnv, hostNamespace, phoneSocketFactory, relaySigner, stubObjectGlobals, stubUpgradeGlobals, type RelaySigner } from './director-fixture'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { default: worker, HostRelay } = await import('../src/index')

const HOST = 'AbCdEfGhIjKlMnOp'
const USER = 'user-1'
const RESUME_TOKEN = 'R'.repeat(43)
let signer: RelaySigner

beforeAll(async () => {
  stubObjectGlobals()
  stubUpgradeGlobals()
  signer = await relaySigner()
})

// One Worker environment with real host objects; `fetchFrom(country)` is what a client's fetch
// reaches from that country (the platform's request.cf.country).
function director() {
  const env: Record<string, unknown> = { ...baseEnv(signer.jwks), ...DIRECTOR_VARS }
  const hosts = hostNamespace((ctx) => new HostRelay(ctx, env))
  env.HOST_RELAY = hosts.namespace
  const bodies: (string | null)[] = []
  const fetchFrom = (country?: string) => async (input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? init.body : null)
    return worker.fetch(Object.assign(new Request(input, init), country ? { cf: { country } } : {}), env)
  }
  const store = () => hosts.namespace.get(HOST)['store']
  const credentials = () => new RelayCredentialStore(store().database)
  // The desktop's own pacing between asks, on a virtual clock so tests do not wait it out.
  let clock = Date.now()
  const gate = new RelayAssignRateGate({ now: () => clock, sleep: async (ms) => { clock += ms } })
  return { hosts, fetch: fetchFrom(), fetchFrom, bodies, store, credentials, gate }
}
type Director = ReturnType<typeof director>

const assign = async (d: Director, extra: Partial<Parameters<typeof requestRelayAssignment>[0]> = {}) =>
  requestRelayAssignment({ directorUrl: DIRECTOR_URL, relayToken: await signer.mint({ user: USER, host: HOST }), relayHostId: HOST, fetch: d.fetch, assignRateGate: d.gate, ...extra })

async function pairPhone(d: Director): Promise<void> {
  await d.store().database.query(
    `INSERT INTO relay_devices (user_id, relay_host_id, relay_device_id, current_hash, current_version, current_expires_at,
       grace_hash, grace_version, grace_expires_at, revoked_at, updated_at) VALUES (?, ?, 'phone-1', ?, 1, ?, NULL, NULL, NULL, NULL, ?)`,
    [USER, HOST, hashCredential(RESUME_TOKEN), Date.now() + 86_400_000, Date.now()]
  )
}

describe('desktop: POST /v1/assign through the shipped client', () => {
  it('parses the answer with its strict schema: the contract keys only, no regionCorrection', async () => {
    const d = director()
    const assignment = await assign(d)
    expect(assignment).toEqual({ v: 1, cellUrl: EDGE_URL, assignmentEpoch: 1, lease: expect.any(String) })
    expect(assignment.lease.length).toBeLessThanOrEqual(8 * 1024)
    const token = await signer.mint({ user: USER, host: HOST })
    const raw = await (await d.fetch(`${DIRECTOR_URL}/v1/assign`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ v: 1, relayHostId: HOST }) })).json()
    expect(Object.keys(raw).sort()).toEqual(['assignmentEpoch', 'cellUrl', 'lease', 'v'])
    expect(AssignmentResponseSchema.parse(raw)).toEqual(raw)
  })

  it('accepts and ignores a region correction report and takes the region preference as a location hint (one request)', async () => {
    const d = director()
    const report = { v: 1, action: 'report', generation: 3, assignmentEpoch: 1, policyVersion: 1, outcome: 'conclusive', measurements: { 'us-central1': 200, 'asia-east2': 40 } } as const
    const assignment = await assign(d, { preferredRegion: 'asia-east2', reconnect: true, regionCorrection: report })
    expect(assignment).toEqual({ v: 1, cellUrl: EDGE_URL, assignmentEpoch: 1, lease: expect.any(String) })
    // Sent once: no 400, so no compatibility retry without the field.
    expect(d.bodies.map((b) => JSON.parse(b ?? '{}'))).toEqual([{ v: 1, relayHostId: HOST, regionCorrection: report, preferredRegion: 'asia-east2', reconnect: true }])
    expect(d.hosts.hints.get(HOST)).toBe('apac')
  })

  it('keeps the epoch across asks and bumps it when the caller country moves the host to the front door', async () => {
    const d = director()
    expect((await assign(d)).assignmentEpoch).toBe(1)
    expect((await assign(d)).assignmentEpoch).toBe(1)
    expect(await assign(d, { fetch: d.fetchFrom('CN') })).toMatchObject({ cellUrl: FRONT_DOOR_URL, assignmentEpoch: 2 })
    expect(await assign(d, { fetch: d.fetchFrom('CN') })).toMatchObject({ cellUrl: FRONT_DOOR_URL, assignmentEpoch: 2 })
    expect(await assign(d, { fetch: d.fetchFrom('US') })).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 3 })
  })

  it('refusals carry the statuses and Retry-After the client acts on', async () => {
    const d = director()
    const status = async (relayToken: string) => (await requestRelayAssignment({ directorUrl: DIRECTOR_URL, relayToken, relayHostId: HOST, fetch: d.fetch, assignRateGate: d.gate }).catch((e: unknown) => e))
    expect(await status('not-a-jwt')).toMatchObject({ statusCode: 401 })
    expect(await status(await signer.mint({ user: USER, host: 'ZZZZZZZZZZZZZZZZ' }))).toMatchObject({ statusCode: 403 })
    await d.store().applyAssignment({ userId: USER, relayHostId: HOST, cellId: 'us-c1', assignmentEpoch: 9 })
    const elsewhere = await assign(d).catch((e: unknown) => e)
    expect(elsewhere).toBeInstanceOf(RelayHttpError)
    expect(elsewhere).toMatchObject({ statusCode: 503, retryAfterMs: 30_000 })
  })
})

describe('desktop: GET /v1/regions through the shipped catalog fetch', () => {
  it('accepts the catalog, including its probe-origin ownership check', async () => {
    const catalog = await fetchRelayRegionCatalog(DIRECTOR_URL, director().fetch, 1_000)
    expect(catalog.regions.map((r) => r.region)).toEqual(['us-central1', 'asia-east2'])
  })
})

describe('phone: POST /v1/resolve through the shipped client', () => {
  const endpoint = { v: 1, directorUrl: DIRECTOR_URL, cellUrl: 'https://old.cell.example', assignmentEpoch: 0, relayHostId: HOST, e2eeFraming: 2 } as const

  it('resolves a paired phone to the URL its host was handed, contract keys only', async () => {
    const d = director()
    await assign(d, { fetch: d.fetchFrom('CN') })
    await pairPhone(d)
    expect(await resolveMobileRelayEndpoint({ relay: endpoint, resumeToken: RESUME_TOKEN, fetchImpl: d.fetch })).toEqual({ ...endpoint, cellUrl: FRONT_DOOR_URL, assignmentEpoch: 1 })
    const raw = await (await d.fetch(`${DIRECTOR_URL}/v1/resolve`, { method: 'POST', body: JSON.stringify({ v: 1, relayHostId: HOST, resumeToken: RESUME_TOKEN }) })).json()
    expect(Object.keys(raw).sort()).toEqual(['assignmentEpoch', 'cellUrl', 'leaseExpiresAt', 'v'])
    expect(ResolveResponseSchema.parse(raw)).toEqual(raw)
  })

  it('an unknown token, or a host never placed, is a 401 as from the legacy director', async () => {
    const d = director()
    const unknown = { relay: endpoint, resumeToken: 'B'.repeat(43), fetchImpl: d.fetch }
    await expect(resolveMobileRelayEndpoint(unknown)).rejects.toMatchObject({ status: 401 })
    await assign(d)
    await expect(resolveMobileRelayEndpoint(unknown)).rejects.toMatchObject({ status: 401 })
  })
})

describe('phone: invite move over WS /v1/connect/<host> through the shipped client', () => {
  const pairing = (inviteToken: string, assignmentEpoch = 0) => ({
    v: 1,
    directorUrl: DIRECTOR_URL,
    cellUrl: 'https://old.cell.example',
    assignmentEpoch,
    relayHostId: HOST,
    inviteToken,
    inviteExpiresAt: Date.now() + 60_000
  }) as const

  it('a valid invite is answered relay-moved with the host cell and a newer epoch', async () => {
    const d = director()
    await assign(d)
    const invite = await d.credentials().createInvite({ userId: USER, relayHostId: HOST }, 'phone-1')
    const moved = await resolvePairingInviteThroughDirector({ relay: pairing(invite.inviteToken), createSocket: phoneSocketFactory(d.fetch) })
    expect(moved).toMatchObject({ cellUrl: EDGE_URL, assignmentEpoch: 1 })
  })

  it('an invalid invite is refused, as the legacy director refuses it', async () => {
    const d = director()
    await assign(d)
    await expect(resolvePairingInviteThroughDirector({ relay: pairing('I'.repeat(43)), createSocket: phoneSocketFactory(d.fetch) })).rejects.toThrow('invalid relay director move')
  })
})
