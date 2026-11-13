// G1 (China research, architecture.md §9.8): the staging front door (global external Application
// Load Balancer + global internet NEG) in front of a phase-2 staging edge Worker. Drives the
// SHIPPED desktop control client and data transport, and phone-like sockets, through it; then holds
// a control socket and an idle phone splice for G1_HOLD_MS (default 10 min).
//
//   G1_FRONT_DOOR=https://<front door hostname> G1_EDGE=https://<staging edge hostname> \
//   G1_ADMIN_KEY_FILE=<file with the edge admin signing key> G1_ADMIN_ISSUER=<edge ADMIN_ISSUER> \
//   npx tsx test/g1-front-door.ts
// Optional: G1_JWT_KEYS (default spike/.keys.json: the test JWKS the staging edge trusts),
// G1_JWT_ISSUER, G1_INGRESS_NAME (default cn), G1_HOLD_MS, G1_PREAUTH_PROBES (default 0: skip),
// G1_OUT (write the results as JSON). Prints no secrets or tokens.
//
// The staging edge must have INGRESS_TOKENS / INGRESS_ORIGINS (incl. the front door origin) /
// INGRESS_SOURCE_CIDRS set; otherwise G1.5 fails exactly like the negative control G1.4.
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { importJWK, type JWK, type KeyLike } from 'jose'
import {
  adminAssign,
  desktop,
  mint,
  newHost,
  oversizeControl,
  phoneHello,
  preauthStatus,
  sha,
  sleep,
  unauthenticatedControl,
  waitFor,
  type Account
} from './relay-clients'

const required = (name: string) => {
  const value = process.env[name]?.replace(/\/$/, '')
  if (!value) throw new Error(`${name} is required`)
  return value
}
const FRONT = required('G1_FRONT_DOOR')
const EDGE = required('G1_EDGE')
const ADMIN = { key: readFileSync(required('G1_ADMIN_KEY_FILE'), 'utf8').trim(), issuer: required('G1_ADMIN_ISSUER') }
const KEYS = process.env.G1_JWT_KEYS ?? new URL('../spike/.keys.json', import.meta.url).pathname
const INGRESS_NAME = process.env.G1_INGRESS_NAME ?? 'cn'
const HOLD_MS = Number(process.env.G1_HOLD_MS ?? 10 * 60_000)
const PREAUTH_PROBES = Number(process.env.G1_PREAUTH_PROBES ?? 0)
const ACCOUNT: Account = {
  user: `user-g1-${randomBytes(4).toString('hex')}`,
  epoch: 1,
  jwtIssuer: process.env.G1_JWT_ISSUER ?? 'https://auth.test.invalid',
  jwtKid: 'spike'
}

const results: { name: string; ok: boolean; detail: string }[] = []
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const errorText = (value: unknown) => (value instanceof Error ? value.message.slice(0, 120) : '')

async function main(): Promise<void> {
  const key = (await importJWK((JSON.parse(readFileSync(KEYS, 'utf8')) as { privateJwk: JWK }).privateJwk, 'ES256')) as KeyLike
  const host = newHost()
  const id = host.relayHostId
  const jwt = await mint(ACCOUNT, key, id)
  console.log(`front door ${new URL(FRONT).host} → edge ${new URL(EDGE).host}; hold ${HOLD_MS / 1000} s`)

  // G1.1 The front door answers and is the load balancer (not a direct path to Cloudflare).
  const health = await fetch(`${FRONT}/health`)
  const body = (await health.json().catch(() => null)) as { ok?: boolean } | null
  const via = health.headers.get('via') ?? ''
  record('G1.1 /health through the front door', health.status === 200 && body?.ok === true && /google/i.test(via), `status=${health.status} via=${via || 'none'}`)

  // G1.2 Admin and test routes are refused by the URL map, never forwarded.
  const adminViaFront = await fetch(`${FRONT}/__admin/assign`, { method: 'POST', body: '{}' })
  record('G1.2 /__admin/* through the front door is 404 at the load balancer', adminViaFront.status === 404, `status=${adminViaFront.status}`)

  const pushed = await adminAssign(EDGE, ADMIN, ACCOUNT, id)
  record('G1.3 director push straight to the edge', pushed.outcome === 'applied', `status=${pushed.status} outcome=${pushed.outcome}`)

  // G1.4 Negative control: the same headers straight to the edge, with a made-up token, are not
  // trusted; the edge binds its own origin and the desktop refuses the proof.
  const forged = desktop(ACCOUNT, FRONT, host, jwt, {
    dialOrigin: EDGE,
    extraHeaders: {
      'x-orca-ingress': `v1s ${INGRESS_NAME} ${FRONT} ${randomBytes(32).toString('base64url')}`,
      'x-orca-client-ip': '198.51.100.7',
      'x-orca-client-country': 'CN'
    }
  })
  const forgedAck = await forged.connect().catch((e: Error) => e)
  record(
    'G1.4 negative control: forged token straight to the edge is ignored; proof refused',
    forgedAck instanceof Error && /relayOrigin/.test(forgedAck.message),
    forgedAck instanceof Error ? errorText(forgedAck) : 'connected?!'
  )
  forged.client.closeNow()
  await sleep(500)

  // G1.5 Upgrade + host proof through the front door (the edge trusted the load balancer's headers).
  const started = Date.now()
  const main = desktop(ACCOUNT, FRONT, host, jwt, { appVersion: 'g1-front-door' })
  const ack = await main.connect().catch((e: Error) => e)
  record('G1.5 control upgrade and host proof over the front door origin', !(ack instanceof Error), ack instanceof Error ? errorText(ack) : `generation=${ack.generation} in ${Date.now() - started} ms`)
  if (ack instanceof Error) return

  // G1.6 Pairing and data through two hops.
  const invite = await main.client.createInvite('g1-phone')
  const invitePhone = await phoneHello(FRONT, id, invite.inviteToken)
  const resumeToken = randomBytes(32).toString('base64url')
  const installed = await main.client
    .installCredential({ reqId: 'g1', relayDeviceId: 'g1-phone', newResumeTokenHash: sha(resumeToken), authorization: { mode: 'relay-basis', basisConnId: main.events.lastConnId } })
    .catch((e: Error) => e)
  const sizes = [32, 64 * 1024, 1024 * 1024]
  const echoStart = Date.now()
  for (const size of sizes) invitePhone.ws.send(randomBytes(size))
  await waitFor(() => invitePhone.state.frames.length === sizes.length, 20_000)
  record(
    'G1.6 phone invite, credential install, frames 32 B / 64 KiB / 1 MiB echo unchanged',
    invitePhone.state.hello?.ok === true && !(installed instanceof Error) && invitePhone.state.frames.map((f) => f.length).join() === sizes.join(),
    `hello=${invitePhone.state.hello?.ok} install=${installed instanceof Error ? errorText(installed) : 'ok'} echoed=${invitePhone.state.frames.map((f) => f.length).join('/')} in ${Date.now() - echoStart} ms`
  )
  invitePhone.ws.close(4000, 'g1 invite done')

  // G1.7 Close codes and pre-upgrade refusals pass through unchanged.
  const unknown = await phoneHello(FRONT, id, randomBytes(32).toString('base64url'))
  await waitFor(() => unknown.state.closed !== null, 5000)
  const stray = await phoneHello(FRONT, newHost().relayHostId, randomBytes(32).toString('base64url'))
  await waitFor(() => stray.state.closed !== null, 5000)
  const big = await oversizeControl(FRONT, jwt)
  const noJwt = await unauthenticatedControl(FRONT)
  record(
    'G1.7 close codes: unknown credential 4401, unpushed host 4409, control frame > 1 MiB 1009; 401 before upgrade',
    unknown.state.closed === 4401 && stray.state.closed === 4409 && big === 1009 && noJwt === 401,
    `${unknown.state.closed}/${stray.state.closed}/${big}/${noJwt}`
  )

  // G1.8 Hold: the control stays up on the edge's pings; an idle phone splice stays open with no
  // traffic at all (the backend timeout, not the 24 h cap, governs idle sockets).
  // One frame first: the shipped desktop drops a data socket whose phone never speaks within its
  // attach deadline (a real phone starts its handshake at once). Then nothing at all.
  const idlePhone = await phoneHello(FRONT, id, resumeToken)
  idlePhone.ws.send(randomBytes(32))
  await waitFor(() => idlePhone.state.frames.length > 0, 10_000)
  const attached = idlePhone.state.frames.length
  const holdStart = Date.now()
  const pingsBefore = main.events.serverPings
  while (Date.now() - holdStart < HOLD_MS && main.events.closes.length === 0 && idlePhone.state.closed === null) {
    await sleep(Math.min(60_000, HOLD_MS - (Date.now() - holdStart)))
    console.log(`  hold +${Math.round((Date.now() - holdStart) / 1000)} s: control pings=${main.events.serverPings - pingsBefore} socket pongs=${main.events.socketPongs} control closes=${main.events.closes.join(',') || 'none'} phone=${idlePhone.state.closed ?? 'open'}`)
  }
  const held = Date.now() - holdStart
  const pings = main.events.serverPings - pingsBefore
  idlePhone.ws.send(randomBytes(64 * 1024))
  await waitFor(() => idlePhone.state.frames.length > attached, 10_000)
  record(
    `G1.8 hold ${Math.round(HOLD_MS / 1000)} s: control and idle phone splice stay open; keepalives flow; data after idle`,
    idlePhone.state.hello?.ok === true && held >= HOLD_MS && main.events.closes.length === 0 && idlePhone.state.closed === null && pings >= Math.floor(HOLD_MS / 60_000) && idlePhone.state.frames.length > attached,
    `held=${held} ms control pings=${pings} socket pongs=${main.events.socketPongs} closes=${main.events.closes.join(',') || 'none'} phone=${idlePhone.state.closed ?? 'open'} echo-after-idle=${idlePhone.state.frames.length > attached}`
  )

  // G1.9 Close codes after the hold: the desktop leaves, the edge closes the phone's splice with a
  // relay code (not a bare 1006); then a client-initiated close completes cleanly.
  main.client.closeNow()
  await waitFor(() => idlePhone.state.closed !== null, 45_000)
  record('G1.9 after the hold, the edge close code reaches the phone (4408 peer dropped, not 1006)', idlePhone.state.closed === 4408, `phone close=${idlePhone.state.closed} reason=${idlePhone.state.reason}`)

  // G1.10 Optional: pre-auth limiting through the front door (keyed on this client's address).
  if (PREAUTH_PROBES > 0) {
    const probeHost = newHost().relayHostId
    const statuses: number[] = []
    for (let i = 0; i < PREAUTH_PROBES; i++) statuses.push(await preauthStatus(FRONT, probeHost))
    record('G1.10 pre-auth probes through the front door (informational)', statuses.includes(426), `first=${statuses[0]} limitedFrom=${statuses.indexOf(429)} last=${statuses.at(-1)}`)
  }
}

main()
  .catch((error) => record('G1 run', false, errorText(error)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length}/${results.length} passed`)
    if (process.env.G1_OUT) writeFileSync(process.env.G1_OUT, JSON.stringify({ at: new Date().toISOString(), holdMs: HOLD_MS, results }, null, 2))
    process.exit(failed.length ? 1 : 0)
  })
