// Drives the wake Worker in local workerd the way the desktop and the connector will: wake tokens
// on the upgrade, keepalives, the close-code table, the connector's signed admin wake.
//   pnpm test:protocol
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair } from 'jose'
import {
  CONNECTOR_WAKE_CLOSE_CODE,
  CONNECTOR_WAKE_FRAME,
  CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME,
  CONNECTOR_WAKE_KEEPALIVE_FRAME,
  CONNECTOR_WAKE_PATH
} from '../../../packages/connector-contract/src/wake-messages'
import { adminWake, killAllDev, mintWake, newHost, record, results, sleep, startDev, waitFor } from './harness'
import { dialWake } from './wake-client'

const ISSUER = 'https://auth.test.invalid'
const ADMIN = { key: randomBytes(36).toString('base64url'), issuer: 'https://connector.test.invalid' }
const ADMIN_NEXT = randomBytes(36).toString('base64url')

async function main(): Promise<void> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const other = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' }
  const jwks = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', () => r()))
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as { port: number }).port}/jwks`
  const base = { WAKE_ADMIN_KEY: ADMIN.key, WAKE_ADMIN_ISSUER: ADMIN.issuer, WAKE_AUTH_ISSUER: ISSUER }

  const dev = await startDev({ ...base, WAKE_ADMIN_KEY_NEXT: ADMIN_NEXT, WAKE_JWKS_URL: jwksUrl })
  try {
    const { origin } = dev
    const mint = (host = newHost(), opts = {}) => mintWake(privateKey, host, { issuer: ISSUER, ...opts })

    // Hardening and routing.
    {
      const query = await fetch(`${origin}${CONNECTOR_WAKE_PATH}?x=1`)
      const plain = await fetch(`${origin}${CONNECTOR_WAKE_PATH}`, { headers: { authorization: `Bearer ${await mint()}` } })
      const unknown = await fetch(`${origin}/v1/other`)
      const health = await fetch(`${origin}/__health/object`)
      const healthBody = (await health.json()) as { ok?: boolean }
      record('H1 query string 400, non-upgrade 426, unknown path 404, object probe 200', query.status === 400 && plain.status === 426 && unknown.status === 404 && health.status === 200 && healthBody.ok === true, `${query.status}/${plain.status}/${unknown.status}/${health.status}`)
    }

    // Auth at the upgrade: anything but a valid wake token for this issuer is a 401.
    {
      const host = newHost()
      const cases = {
        none: dialWake(origin, ''),
        otherKey: dialWake(origin, await mintWake(other.privateKey, host, { issuer: ISSUER })),
        expired: dialWake(origin, await mint(host, { expiresIn: Math.floor(Date.now() / 1000) - 120 })),
        relayAudience: dialWake(origin, await mint(host, { audience: 'orca-connector' })),
        connectorPurpose: dialWake(origin, await mint(host, { purpose: 'connector-host' })),
        otherIssuer: dialWake(origin, await mintWake(privateKey, host, { issuer: 'https://evil.invalid' })),
        shortMid: dialWake(origin, await mint({ sub: 'acct', mid: 'health', hostId: 'acct:health' }))
      }
      await waitFor(() => Object.values(cases).every((c) => c.state.refused !== null || c.state.closed !== null), 5000)
      const statuses = Object.fromEntries(Object.entries(cases).map(([k, c]) => [k, c.state.refused?.status ?? 'open']))
      record('A1 no token, wrong key, expired, wrong audience/purpose/issuer, short mid: all 401', Object.values(statuses).every((s) => s === 401), JSON.stringify(statuses))
    }

    // Connect, keepalive auto-answered, wake delivered as the exact content-free frame.
    const host = newHost()
    const first = dialWake(origin, await mint(host), { gapMs: 1234 })
    await waitFor(() => first.state.open, 5000)
    record('C1 valid wake token opens the socket', first.state.open)
    first.send(CONNECTOR_WAKE_KEEPALIVE_FRAME)
    await waitFor(() => first.state.acks > 0, 3000)
    record('C2 keepalive answered with the exact ack frame', first.state.frames.includes(CONNECTOR_WAKE_KEEPALIVE_ACK_FRAME))
    {
      const before = first.state.wakes.length
      const woke = await adminWake(origin, [host.hostId], ADMIN)
      await waitFor(() => first.state.wakes.length > before, 3000)
      const frame = first.state.frames.at(-1)
      record('W1 admin wake: 200 {delivered:1}, socket gets exactly {"type":"wake"}', woke.status === 200 && JSON.stringify(woke.json) === JSON.stringify({ delivered: 1, noSocket: 0, error: 0 }) && frame === CONNECTOR_WAKE_FRAME, `${woke.status} ${JSON.stringify(woke.json)} ${frame}`)
      const never = newHost()
      const mixed = await adminWake(origin, [host.hostId, never.hostId, host.hostId], ADMIN)
      record('W2 duplicate ids wake once; never-connected host counts no_socket', JSON.stringify(mixed.json) === JSON.stringify({ delivered: 1, noSocket: 1, error: 0 }), JSON.stringify(mixed.json))
    }

    // Admin auth: bound to key, body, op, purpose and audience; _NEXT verifies; bad bodies 400.
    {
      const ids = [host.hostId]
      const forged = await adminWake(origin, ids, { ...ADMIN, key: randomBytes(36).toString('base64url') })
      const otherBody = await adminWake(origin, ids, ADMIN, { tokenBody: JSON.stringify({ hosts: [newHost().hostId] }) })
      const otherOp = await adminWake(origin, ids, ADMIN, { op: 'erase' })
      const otherPurpose = await adminWake(origin, ids, ADMIN, { purpose: 'edge-admin' })
      const otherAudience = await adminWake(origin, ids, ADMIN, { audience: 'orca-relay-edge-admin' })
      const otherIssuer = await adminWake(origin, ids, { ...ADMIN, issuer: 'https://evil.invalid' })
      const statuses = [forged, otherBody, otherOp, otherPurpose, otherAudience, otherIssuer].map((r) => r.status)
      record('P1 forged key, other body/op/purpose/audience/issuer: all 401', statuses.every((s) => s === 401), statuses.join('/'))
      const next = await adminWake(origin, ids, { ...ADMIN, key: ADMIN_NEXT })
      record('P2 rotation: the _NEXT key verifies', next.status === 200, String(next.status))
      const canary = await adminWake(origin, ['canary:health'], ADMIN)
      const empty = await adminWake(origin, [], ADMIN)
      const tooMany = await adminWake(origin, Array.from({ length: 501 }, () => newHost().hostId), ADMIN)
      record('P3 canary id, empty list, 501 hosts: 400', canary.status === 400 && empty.status === 400 && tooMany.status === 400, `${canary.status}/${empty.status}/${tooMany.status}`)
      const big = await fetch(`${origin}/__admin/wake`, { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024) })
      record('P4 body over 256 KB: 401 before parsing', big.status === 401, String(big.status))
    }

    // Replaced: the newer socket wins, the older closes 4409 and does not redial.
    const second = dialWake(origin, await mint(host))
    await waitFor(() => second.state.open && first.state.closed !== null, 5000)
    record('R1 second connect: older closed 4409 (until-hello), newer open', first.state.closed?.code === CONNECTOR_WAKE_CLOSE_CODE.REPLACED && first.state.closed.action === 'until-hello' && second.state.open, JSON.stringify(first.state.closed))
    {
      const firstWakes = first.state.wakes.length
      const woke = await adminWake(origin, [host.hostId], ADMIN)
      await waitFor(() => second.state.wakes.length > 0, 3000)
      record('R2 wake after replace: delivered once, only to the newer socket', JSON.stringify(woke.json) === JSON.stringify({ delivered: 1, noSocket: 0, error: 0 }) && second.state.wakes.length === 1 && first.state.wakes.length === firstWakes, JSON.stringify(woke.json))
    }

    // Attachment cleared on close: a closed socket never counts as delivered.
    second.close()
    await waitFor(() => second.state.closed !== null, 3000)
    await sleep(200)
    {
      const woke = await adminWake(origin, [host.hostId], ADMIN)
      record('K1 after the desktop closes: wake counts no_socket', JSON.stringify(woke.json) === JSON.stringify({ delivered: 0, noSocket: 1, error: 0 }), JSON.stringify(woke.json))
    }

    // Oversized inbound frame closes 1009 (until-hello); small unknown frames are ignored.
    {
      const s = dialWake(origin, await mint())
      await waitFor(() => s.state.open, 5000)
      s.send('{"type":"later-frame"}')
      await sleep(300)
      const stillOpen = s.state.open
      s.send('x'.repeat(2048))
      await waitFor(() => s.state.closed !== null, 3000)
      record('F1 small unknown frame ignored; 2 KB frame closes 1009', stillOpen && s.state.closed?.code === 1009 && s.state.closed.action === 'until-hello', JSON.stringify(s.state.closed))
    }

    // Checked at upgrade only: a socket outlives its token's expiry and still gets wakes.
    {
      const h = newHost()
      const s = dialWake(origin, await mint(h, { expiresIn: Math.floor(Date.now() / 1000) + 2 }), { keepaliveMs: 1000 })
      await waitFor(() => s.state.open, 5000)
      await sleep(3500)
      const woke = await adminWake(origin, [h.hostId], ADMIN)
      await waitFor(() => s.state.wakes.length > 0, 3000)
      record('T1 socket past its token exp: still open, wake delivered', s.state.open && s.state.wakes.length === 1 && s.state.acks >= 2, `${JSON.stringify(woke.json)} acks=${s.state.acks}`)
      s.close()
    }

    // Many hosts in one batch (the publisher's ≤ 500 per call).
    {
      const hosts = Array.from({ length: 40 }, () => newHost())
      const sockets = await Promise.all(hosts.map(async (h) => dialWake(origin, await mint(h))))
      await waitFor(() => sockets.every((s) => s.state.open), 10_000)
      const woke = await adminWake(origin, hosts.map((h) => h.hostId), ADMIN)
      await waitFor(() => sockets.every((s) => s.state.wakes.length === 1), 5000)
      record('B1 40-host batch: delivered 40, each socket woken once', JSON.stringify(woke.json) === JSON.stringify({ delivered: 40, noSocket: 0, error: 0 }) && sockets.every((s) => s.state.wakes.length === 1), JSON.stringify(woke.json))
      for (const s of sockets) { s.close() }
    }

    // Pre-auth limiter (local: 100 per minute per source and kind) answers 429 before any token check.
    {
      const statuses: number[] = []
      for (let i = 0; i < 110; i++) { statuses.push((await fetch(`${origin}/__health/object`)).status) }
      let upgrade: number | 'open' = 'open'
      for (let i = 0; i < 110 && upgrade !== 429; i++) {
        const s = dialWake(origin, 'not-a-token')
        await waitFor(() => s.state.refused !== null || s.state.closed !== null, 3000)
        upgrade = s.state.refused?.status ?? 'open'
      }
      record('L1 pre-auth limiter: health and upgrade answer 429', statuses.includes(429) && upgrade === 429, `upgrade=${upgrade}`)
    }
  } finally {
    await dev.stop()
  }

  // No key set at all (auth unreachable, nothing persisted): 503 + Retry-After, not 401.
  // Every country refused: 4403 after the upgrade, before any token check.
  {
    const deadJwks = 'http://127.0.0.1:9/jwks'
    const refused = await startDev({ ...base, WAKE_JWKS_URL: deadJwks, WAKE_REFUSE_COUNTRIES: 'CN' })
    try {
      const s = dialWake(refused.origin, await mintWake(privateKey, newHost(), { issuer: ISSUER }))
      await waitFor(() => s.state.refused !== null || s.state.closed !== null, 15_000)
      record('J1 no key set: 503 with Retry-After', s.state.refused?.status === 503 && s.state.refused.retryAfter === '5', JSON.stringify(s.state.refused))
    } finally {
      await refused.stop()
    }
    const country = await localCountry()
    if (!country) {
      record('G1 country refused: 4403 (until-hello)', false, 'local workerd reports no cf.country')
    } else {
      const geo = await startDev({ ...base, WAKE_JWKS_URL: deadJwks, WAKE_REFUSE_COUNTRIES: `CN,${country}` })
      try {
        const s = dialWake(geo.origin, 'not-a-token')
        await waitFor(() => s.state.refused !== null || s.state.closed !== null, 5000)
        record('G1 country refused: 4403 (until-hello), even with no valid token', s.state.closed?.code === CONNECTOR_WAKE_CLOSE_CODE.COUNTRY_REFUSED && s.state.closed.action === 'until-hello', `${country} ${JSON.stringify(s.state.closed ?? s.state.refused)}`)
      } finally {
        await geo.stop()
      }
    }
  }
  jwks.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) { process.exitCode = 1 }
}

// Local workerd's request.cf comes from wrangler's cached cf object (node_modules/.mf/cf.json).
async function localCountry(): Promise<string | null> {
  try {
    const { readFileSync } = await import('node:fs')
    const cf = JSON.parse(readFileSync(new URL('../node_modules/.mf/cf.json', import.meta.url), 'utf8')) as { country?: string }
    return cf.country && /^[A-Z]{2}$/.test(cf.country) && cf.country !== 'CN' ? cf.country : null
  } catch {
    return null
  }
}

// Overall bound: a hung socket or dev server fails the run instead of stalling it.
const overall = setTimeout(() => {
  console.error('FAIL overall timeout (240 s)')
  killAllDev()
  process.exit(1)
}, 240_000)
await main()
clearTimeout(overall)
