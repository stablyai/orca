// Phase 2 round trip with the real pieces: the director and a GCE-style cell (the relay app from
// the director branch, as child processes on one Postgres), the deployed phase-2 edge Worker, and
// the SHIPPED desktop control client and phone parser. A host pairs a phone on the cell, moves to
// the edge (director pushes its devices), pairs another phone and revokes the first there, then
// moves back (director exports, writes Postgres, places it on the cell, fences the edge).
//   DIRECTOR_APP=<orca worktree>/cloud/apps/relay DATABASE_URL=postgres://... \
//   EDGE_URL=https://<phase2 worker> EDGE_KEY_FILE=<admin key file> npx tsx test/roundtrip.ts
// The edge's ADMIN_ISSUER must be the local director origin (DIRECTOR_PORT, default 18480).
import { createServer } from 'node:http'
import { exportJWK, generateKeyPair, importJWK, type KeyLike } from 'jose'
import pg from 'pg'
import { loadOrCreateKeys } from '../spike/lib'
import {
  CELL,
  DATABASE_URL,
  DIRECTOR,
  EDGE_URL,
  JWKS_PORT,
  assign,
  children,
  closeControl,
  director,
  heartbeat,
  host,
  online,
  pair,
  phone,
  ready,
  record,
  relay,
  results,
  resumed,
  setKeys,
  sleep,
  stop,
  waitFor
} from './harness-roundtrip'

async function main(): Promise<void> {
  const keys = await loadOrCreateKeys()
  const userKey = (await importJWK(keys.privateJwk, 'ES256')) as KeyLike
  const admin = await generateKeyPair('RS256', { extractable: true })
  setKeys(userKey, admin.privateKey)
  const adminJwk = { ...(await exportJWK(admin.publicKey)), kid: 'admin-key', alg: 'RS256', use: 'sig' }
  const jwks = createServer((_q, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [{ ...keys.publicJwk, kid: 'spike', alg: 'ES256', use: 'sig' }, adminJwk] }))
  })
  await new Promise<void>((r) => jwks.listen(JWKS_PORT, '127.0.0.1', () => r()))
  const db = new pg.Client({ connectionString: DATABASE_URL })
  const beat = setInterval(() => void heartbeat(), 5_000)
  try {
    const cell = relay('cell')
    let d = await director({})
    await ready(CELL, cell.log)
    await db.connect()

    // 1. On the GCE cell: pair phone A.
    const first = await assign()
    const e1 = Number(first.body.assignmentEpoch)
    if (first.status !== 200) { console.log(JSON.stringify(first.body), d.log.join('').slice(-3000)) }
    record('1 director places the host on the cell', first.status === 200 && first.body.cellUrl === CELL, JSON.stringify({ status: first.status, cellUrl: first.body.cellUrl, epoch: e1 }))
    const onCell = await online(CELL, e1)
    const tokenA = await pair(onCell, CELL, 'phone-a')
    record('1 phone A resumes on the cell', resumed(await phone(CELL, tokenA)))
    await closeControl(onCell)

    // 2. Cohort on: the director pushes the host and phone A to the edge.
    await stop(d.child)
    d = await director({ allow: true })
    // A host still holding a unit on its old cell (the pairing invite) stays there, never a 503.
    let toEdge = await assign()
    const firstAsk = toEdge
    const askStarted = Date.now()
    while (toEdge.status === 200 && toEdge.body.cellUrl === CELL && Date.now() - askStarted < 720_000) {
      await sleep(20_000)
      toEdge = await assign()
    }
    record('2 while old-cell units settle the host stays on the cell (200, not 503)', firstAsk.status === 200, JSON.stringify({ status: firstAsk.status, cellUrl: firstAsk.body.cellUrl, movedAfterS: Math.round((Date.now() - askStarted) / 1000) }))
    const e2 = Number(toEdge.body.assignmentEpoch)
    record('2 director answers the edge with a newer epoch', toEdge.status === 200 && toEdge.body.cellUrl === EDGE_URL && e2 > e1, JSON.stringify({ status: toEdge.status, cellUrl: toEdge.body.cellUrl, epoch: e2, body: toEdge.status === 200 ? undefined : toEdge.body }))
    const onEdge = await online(EDGE_URL, e2)
    record('2 phone A (paired on the cell) resumes on the edge', resumed(await phone(EDGE_URL, tokenA)))
    const oldCell = await phone(CELL, tokenA)
    await waitFor(() => oldCell.state.closed !== null, 4000)
    record('2 the old cell tells phone A WRONG_CELL (4409)', oldCell.state.closed === 4409 || oldCell.state.hello?.code === 4409, `close=${oldCell.state.closed} hello=${JSON.stringify(oldCell.state.hello)}`)

    // 3. On the edge: pair phone B, revoke phone A.
    const tokenB = await pair(onEdge, EDGE_URL, 'phone-b')
    await onEdge.client.revokeDevice('phone-a')
    record('3 phone B resumes on the edge', resumed(await phone(EDGE_URL, tokenB)))

    // 4. Cohort off while the desktop is still on the edge: retry, nothing moves.
    await stop(d.child)
    d = await director({ deny: true })
    const busy = await assign()
    record('4 leaving while the desktop is connected to the edge: 503 Retry-After', busy.status === 503, `status=${busy.status}`)
    await closeControl(onEdge)

    // 5. Move back: export, Postgres devices replaced, placed on the cell, edge fenced.
    const back = await assign()
    const e3 = Number(back.body.assignmentEpoch)
    record('5 director places the host back on the cell with a newer epoch', back.status === 200 && back.body.cellUrl === CELL && e3 > e2, JSON.stringify({ status: back.status, cellUrl: back.body.cellUrl, epoch: e3, body: back.status === 200 ? undefined : back.body }))
    const rows = (
      await db.query(`SELECT relay_device_id, revoked_at FROM relay_devices WHERE relay_host_id = $1 ORDER BY relay_device_id`, [host.relayHostId])
    ).rows.map((r) => `${r.relay_device_id}:${r.revoked_at === null ? 'live' : 'revoked'}`)
    record('5 Postgres has the edge-side changes (A revoked, B paired)', rows.join(',') === 'phone-a:revoked,phone-b:live', rows.join(','))
    const fenced = await phone(EDGE_URL, tokenB)
    await waitFor(() => fenced.state.closed !== null, 4000)
    record('5 the edge tells phones WRONG_CELL (4409) after the move', fenced.state.closed === 4409, `close=${fenced.state.closed}`)
    const backOnCell = await online(CELL, e3)
    record('5 phone B (paired on the edge) resumes on the cell', resumed(await phone(CELL, tokenB)))
    const revoked = await phone(CELL, tokenA)
    await waitFor(() => revoked.state.closed !== null, 4000)
    // A cell's database path answers any credential it cannot place with WRONG_CELL (today's
    // behaviour); the phone then re-resolves, and the director must refuse the revoked token.
    // B first: a failed resolve rate-limits the host's next one (today's director rule).
    const resolveB = await fetch(`${DIRECTOR}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: host.relayHostId, resumeToken: tokenB })
    })
    const resolveA = await fetch(`${DIRECTOR}/v1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, relayHostId: host.relayHostId, resumeToken: tokenA })
    })
    record(
      '5 phone A (revoked on the edge) is not admitted on the cell, and the director will not resolve it',
      !resumed(revoked) && revoked.state.closed !== null && resolveA.status !== 200 && resolveB.status === 200,
      `close=${revoked.state.closed} resolveA=${resolveA.status} resolveB=${resolveB.status}`
    )
    await closeControl(backOnCell)
  } finally {
    clearInterval(beat)
    await db.end().catch(() => undefined)
    for (const child of children) { await stop(child) }
    jwks.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) { process.exitCode = 1 }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
  for (const child of children) { child.kill('SIGKILL') }
  process.exit(1)
})
