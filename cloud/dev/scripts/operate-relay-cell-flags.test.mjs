import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertSupportedObject,
  desiredObject,
  operateCellFlags,
  parseCellFlagsRequest,
  parseFlagChanges,
  READ_BACK_TIMEOUT_MS,
  REREGISTER_WAIT_MAX_MS,
  REREGISTER_WAIT_MIN_MS,
  reregisterLanes,
  reregisterWaitMs,
  WRITE_CONFIRMATION
} from './operate-relay-cell-flags.mjs'

const CELL = 'production-gce-c26'
const RESERVE = { 'director-origin': 'https://relay.onorca.dev', 'confirm-reserve': `RESERVE ${CELL}` }
const values = (overrides = {}) => ({
  mode: 'write',
  'cell-id': CELL,
  'cell-origin': 'https://c26.relay.onorca.dev',
  'project-id': 'onorca-cloud',
  set: 'readinessLocal=true',
  'expected-generation': '0',
  confirmation: `${WRITE_CONFIRMATION} ${CELL}`,
  ...overrides
})

// A cell whose runtime status applies whatever was written, after `applyAfterPolls` polls.
const SUPPORTED = {
  readinessLocal: { type: 'boolean' },
  ticketCheck: { type: 'enum', values: ['off', 'shadow', 'enforce'] },
  admitMode: { type: 'enum', values: ['db', 'reserve'] },
  intakePerSec: { type: 'number', min: 0, max: 1_000 },
  reserveDryRun: { type: 'boolean' },
  rejectionFence: { type: 'boolean' },
  readTimeoutMarginMs: { type: 'number', min: 1_000, max: 60_000, integer: true },
  reregisterInFlight: { type: 'number', min: 1, max: 16, integer: true }
}

function fakeGoogleAndCell({
  stored = null,
  applyAfterPolls = 2,
  role = 'cell',
  cellId = CELL,
  supportedFlags = SUPPORTED,
  // Polls that still report admitModeEffective=reserve after a flip back.
  reregisteringPolls = 0,
  controls,
  // Forces admitModeEffective, as a tripped dead-man reports it.
  effectiveOverride,
  heartbeatFresh = false,
  // The director refuses this numbered reserve post (1-based) with this error.
  refuseReservePost
} = {}) {
  const state = {
    stored,
    writes: [],
    polls: 0,
    // A cell that has applied whatever object is already there.
    applied: stored
      ? { generation: Number(stored.generation), flags: stored.object.flags }
      : { generation: 0, flags: { readinessLocal: false, ticketCheck: 'off' } },
    directorAdmitMode: 'db',
    reservePosts: 0,
    order: [],
    reregisteringPolls
  }
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url)
    if (target.pathname === '/v1/admin/cell-admit-mode') {
      const body = JSON.parse(String(init.body))
      if (body.admitMode === 'reserve') {
        state.reservePosts += 1
        if (refuseReservePost?.post === state.reservePosts) {
          return Response.json({ error: refuseReservePost.error }, { status: 409 })
        }
      }
      if (body.admitMode) {
        state.directorAdmitMode = body.admitMode
        state.order.push(`director:${body.admitMode}`)
      }
      return Response.json({ v: 1, cellId: body.cellId, admitMode: state.directorAdmitMode, updatedAt: 1, heartbeatFresh })
    }
    if (target.pathname === '/v1/admin/runtime-status') {
      state.polls += 1
      if (state.stored && state.polls > applyAfterPolls) {
        state.applied = { generation: Number(state.stored.generation), flags: state.stored.object.flags }
      }
      const reserveApplied = state.applied.flags.admitMode === 'reserve'
      const effective = reserveApplied || (state.writes.length > 0 && state.reregisteringPolls-- > 0) ? 'reserve' : 'db'
      return Response.json({
        v: 1,
        role,
        cellId,
        flagsApplied: state.applied,
        admitModeEffective: effectiveOverride ?? effective,
        ...(controls === undefined ? {} : { runtime: { controls } }),
        ...(supportedFlags ? { supportedFlags } : {})
      })
    }
    if (target.pathname.startsWith('/upload/')) {
      const expected = target.searchParams.get('ifGenerationMatch')
      if (expected !== (state.stored?.generation ?? '0')) return new Response(null, { status: 412 })
      const parts = String(init.body).split('\r\n')
      const object = JSON.parse(parts[parts.indexOf('Content-Type: application/json') + 2])
      const metadata = JSON.parse(parts[3])
      const generation = String(Number(state.stored?.generation ?? 1000) + 1)
      state.stored = { generation, object }
      state.writes.push({ generation, object, metadata })
      state.order.push(`file:${object.flags.admitMode ?? 'db'}`)
      return Response.json({ generation })
    }
    if (!state.stored) return new Response(null, { status: 404 })
    if (target.searchParams.get('alt') === 'media') return Response.json(state.stored.object)
    return Response.json({ generation: state.stored.generation })
  }
  return { state, fetchImpl }
}

const run = (request, fake, extra = {}) => {
  let clock = 0
  const lines = []
  return {
    lines,
    result: operateCellFlags(request, {
      fetchImpl: fake.fetchImpl,
      accessToken: 'access',
      idToken: 'id',
      audit: { writtenBy: 'octocat', runId: '42', runAttempt: '1' },
      log: (line) => lines.push(JSON.parse(line)),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      ...extra
    })
  }
}

test('refuses malformed requests before touching anything', () => {
  assert.throws(() => parseCellFlagsRequest(values({ mode: 'apply' })), /mode/)
  assert.throws(() => parseCellFlagsRequest(values({ 'cell-id': 'all' })), /cell id/)
  assert.throws(() => parseCellFlagsRequest(values({ set: 'ticketCheck=always' })), /ticketCheck/)
  assert.throws(() => parseCellFlagsRequest(values({ set: 'placerMode=on' })), /unknown switch/)
  assert.throws(() => parseCellFlagsRequest(values({ set: '' })), /names no switch/)
  assert.throws(() => parseCellFlagsRequest(values({ set: 'admitMode=db,admitMode=reserve' })), /twice/)
  assert.throws(() => parseCellFlagsRequest(values({ set: 'readTimeoutMarginMs=500' })), /cannot be/)
  assert.throws(() => parseCellFlagsRequest(values({ 'expected-generation': '' })), /expected/)
  assert.throws(() => parseCellFlagsRequest(values({ confirmation: WRITE_CONFIRMATION })), /confirmation/)
  assert.throws(
    () => parseCellFlagsRequest(values({ 'cell-origin': 'https://c27.relay.onorca.dev' })),
    /another cell/
  )
  assert.throws(() => parseCellFlagsRequest(values({ 'cell-origin': 'https://evil.example' })), /origin/)
  // A dry run needs no confirmation.
  assert.equal(parseCellFlagsRequest(values({ mode: 'dry-run', confirmation: '' })).mode, 'dry-run')
})

test('a dry run reports the change and writes nothing', async () => {
  const fake = fakeGoogleAndCell()
  const { result, lines } = run(parseCellFlagsRequest(values({ mode: 'dry-run' })), fake)
  const outcome = await result
  assert.equal(outcome.written, false)
  assert.equal(fake.state.writes.length, 0)
  assert.equal(lines[0].event, 'orca_relay_cell_flags_plan')
  assert.deepEqual(lines[0].desired.flags, { readinessLocal: true })
})

test('writes with compare-and-swap, records who wrote it, and waits for the cell to apply it', async () => {
  const fake = fakeGoogleAndCell()
  const { result, lines } = run(parseCellFlagsRequest(values()), fake)
  const outcome = await result
  assert.equal(outcome.written, true)
  assert.equal(outcome.generation, '1001')
  assert.deepEqual(outcome.applied, { generation: 1001, flags: { readinessLocal: true } })
  assert.deepEqual(fake.state.writes[0].metadata.metadata, { writtenBy: 'octocat', runId: '42', runAttempt: '1' })
  assert.deepEqual(fake.state.writes[0].object, {
    v: 1,
    cellId: CELL,
    flags: { readinessLocal: true }
  })
  assert.deepEqual(lines.map((line) => line.event), [
    'orca_relay_cell_flags_plan',
    'orca_relay_cell_flags_written',
    'orca_relay_cell_flags_applied_read_back'
  ])
  // Flip back: the next write must name the generation just written.
  const back = run(
    parseCellFlagsRequest(values({ set: 'readinessLocal=false', 'expected-generation': '1001' })),
    fake
  )
  assert.equal((await back.result).generation, '1002')
})

test('refuses a stale expected generation, and a concurrent writer between read and write', async () => {
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: {} } }
  })
  await assert.rejects(run(parseCellFlagsRequest(values()), fake).result, /current generation is 7/)
  assert.equal(fake.state.writes.length, 0)
  const racing = fakeGoogleAndCell()
  const write = racing.fetchImpl
  racing.fetchImpl = async (url, init) => {
    if (new URL(url).pathname.startsWith('/upload/')) racing.state.stored = { generation: '9', object: {} }
    return await write(url, init)
  }
  await assert.rejects(run(parseCellFlagsRequest(values()), racing).result, /changed since/)
})

test('a dry run against a stale generation still shows the plan, then refuses', async () => {
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: {} } }
  })
  const { result, lines } = run(parseCellFlagsRequest(values({ mode: 'dry-run' })), fake)
  await assert.rejects(result, /current generation is 7/)
  assert.equal(lines[0].event, 'orca_relay_cell_flags_plan')
  assert.equal(lines[0].currentGeneration, '7')
})

test('rides out a transient 5xx on the first read and during the read-back', async () => {
  const fake = fakeGoogleAndCell()
  const inner = fake.fetchImpl
  let runtimeCalls = 0
  fake.fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status') {
      runtimeCalls += 1
      // The first call, and the first read-back poll after the write.
      if (runtimeCalls === 1 || runtimeCalls === 3) return new Response(null, { status: 503 })
    }
    return await inner(url, init)
  }
  const outcome = await run(parseCellFlagsRequest(values()), fake).result
  assert.equal(outcome.written, true)
  assert.equal(outcome.generation, '1001')
})

test('refuses an origin that is not the named cell, or an image without the flag channel', async () => {
  await assert.rejects(
    run(parseCellFlagsRequest(values()), fakeGoogleAndCell({ cellId: 'production-gce-c25' })).result,
    /not production-gce-c26/
  )
  const old = fakeGoogleAndCell()
  const fetchImpl = old.fetchImpl
  old.fetchImpl = async (url, init) =>
    new URL(url).pathname === '/v1/admin/runtime-status'
      ? Response.json({ v: 1, role: 'cell', cellId: CELL })
      : await fetchImpl(url, init)
  await assert.rejects(run(parseCellFlagsRequest(values()), old).result, /no flag channel/)
})

test('fails loudly when the cell does not apply the write within the read-back window', async () => {
  const fake = fakeGoogleAndCell({ applyAfterPolls: READ_BACK_TIMEOUT_MS })
  await assert.rejects(run(parseCellFlagsRequest(values()), fake).result, /did not apply generation 1001/)
  assert.equal(fake.state.writes.length, 1)
})

test('changes only the named switches and keeps every other key the object already has', () => {
  const current = {
    v: 1,
    cellId: CELL,
    flags: { readinessLocal: true, ticketCheck: 'shadow', readTimeoutMarginMs: 5_000 }
  }
  const request = parseCellFlagsRequest(
    values({ set: 'admitMode=reserve, intakePerSec=40, readTimeoutMarginMs=default', ...RESERVE })
  )
  assert.deepEqual(desiredObject(request, current), {
    v: 1,
    cellId: CELL,
    flags: { readinessLocal: true, ticketCheck: 'shadow', admitMode: 'reserve', intakePerSec: 40 }
  })
  assert.deepEqual(desiredObject(request, null).flags, { admitMode: 'reserve', intakePerSec: 40 })
  assert.throws(() => desiredObject(request, { v: 1, cellId: 'production-gce-c27', flags: {} }), /by hand/)
  assert.deepEqual(parseFlagChanges('rejectionFence=false'), { rejectionFence: false })
  assert.deepEqual(parseFlagChanges('reregisterInFlight=8'), { reregisterInFlight: 8 })
  assert.throws(() => parseFlagChanges('reregisterInFlight=32'), /cannot be/)
})

test('a write keeps the switches it did not name, end to end', async () => {
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { ticketCheck: 'shadow' } } }
  })
  const outcome = await run(parseCellFlagsRequest(values({ 'expected-generation': '7' })), fake).result
  assert.equal(outcome.written, true)
  assert.deepEqual(fake.state.writes[0].object.flags, { ticketCheck: 'shadow', readinessLocal: true })
})

test('the read-back compares every switch, not only the one this run changed', async () => {
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { ticketCheck: 'shadow' } } }
  })
  const inner = fake.fetchImpl
  fake.fetchImpl = async (url, init) => {
    const response = await inner(url, init)
    if (new URL(url).pathname !== '/v1/admin/runtime-status') return response
    const body = await response.json()
    // The cell reports the new generation but still runs the old ticketCheck.
    if (body.flagsApplied.generation === 8) body.flagsApplied.flags = { readinessLocal: true }
    return Response.json(body)
  }
  await assert.rejects(
    run(parseCellFlagsRequest(values({ 'expected-generation': '7' })), fake).result,
    /did not apply generation 8/
  )
})

test('a switch the cell reports on its own is compared only when the object names it', async () => {
  const fake = fakeGoogleAndCell()
  const inner = fake.fetchImpl
  fake.fetchImpl = async (url, init) => {
    const response = await inner(url, init)
    if (new URL(url).pathname !== '/v1/admin/runtime-status') return response
    const body = await response.json()
    body.flagsApplied.flags = { ...body.flagsApplied.flags, intakePerSec: 50, readTimeoutMarginMs: 10_000 }
    return Response.json(body)
  }
  assert.equal((await run(parseCellFlagsRequest(values()), fake).result).written, true)
})

test('fails the read-back when the cell ignores a switch the object names', async () => {
  const fake = fakeGoogleAndCell()
  const inner = fake.fetchImpl
  fake.fetchImpl = async (url, init) => {
    const response = await inner(url, init)
    if (new URL(url).pathname !== '/v1/admin/runtime-status') return response
    const body = await response.json()
    if (body.flagsApplied.generation === 1001) body.flagsApplied.ignoredKeys = ['admitMode']
    return Response.json(body)
  }
  await assert.rejects(
    run(parseCellFlagsRequest(values({ set: 'admitMode=reserve', ...RESERVE })), fake).result,
    /ignores admitMode/
  )
})

test('refuses a switch the cell image does not support, before writing anything', async () => {
  const old = fakeGoogleAndCell({ supportedFlags: null })
  await assert.rejects(
    run(parseCellFlagsRequest(values({ set: 'ticketCheck=enforce' })), old).result,
    /does not support ticketCheck="enforce"/
  )
  await assert.rejects(
    run(parseCellFlagsRequest(values({ set: 'admitMode=reserve', ...RESERVE })), old).result,
    /does not support admitMode/
  )
  assert.equal(old.state.writes.length, 0)
  // An image from before supportedFlags still takes the two switches it always had.
  assert.equal((await run(parseCellFlagsRequest(values()), old).result).written, true)
  assert.throws(
    () => assertSupportedObject({ readTimeoutMarginMs: 1_500.5 }, { supportedFlags: SUPPORTED }),
    /readTimeoutMarginMs/
  )
  assertSupportedObject({ ticketCheck: 'enforce' }, { supportedFlags: SUPPORTED })
})

test('refuses to carry a bad value already in the file', async () => {
  const bad = fakeGoogleAndCell({
    supportedFlags: null,
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { ticketCheck: 'enforce' } } }
  })
  // The old image voided generation 7 and still runs generation 0.
  bad.state.applied = { generation: 0, flags: { readinessLocal: false, ticketCheck: 'off' } }
  await assert.rejects(
    run(parseCellFlagsRequest(values({ 'expected-generation': '7' })), bad).result,
    /does not support ticketCheck="enforce"/
  )
  assert.equal(bad.state.writes.length, 0)
})

const DIRECTOR = { 'director-origin': RESERVE['director-origin'] }

test('admitMode=reserve needs a typed confirmation, and Postgres records reserve before the file', async () => {
  assert.throws(
    () => parseCellFlagsRequest(values({ ...DIRECTOR, set: 'admitMode=reserve' })),
    /--confirm-reserve "RESERVE production-gce-c26"/
  )
  assert.throws(() => parseCellFlagsRequest(values({ set: 'admitMode=db' })), /--director-origin/)
  const fake = fakeGoogleAndCell()
  const request = parseCellFlagsRequest(
    values({ ...DIRECTOR, set: 'admitMode=reserve', 'confirm-reserve': `RESERVE ${CELL}` })
  )
  assert.equal((await run(request, fake).result).written, true)
  // Recorded, re-checked after every director's cache has expired, then the file.
  assert.deepEqual(fake.state.order, ['director:reserve', 'director:reserve', 'file:reserve'])
})

test('a refused file write after Postgres says reserve puts Postgres back to db', async () => {
  const fake = fakeGoogleAndCell()
  const inner = fake.fetchImpl
  fake.fetchImpl = async (url, init) => {
    if (new URL(url).pathname.startsWith('/upload/')) return new Response(null, { status: 403 })
    return await inner(url, init)
  }
  const request = parseCellFlagsRequest(values({ set: 'admitMode=reserve', ...RESERVE }))
  await assert.rejects(run(request, fake).result, /returned 403/)
  assert.deepEqual(fake.state.order, ['director:reserve', 'director:reserve', 'director:db'])
})

test('repairs an object the cell did not apply when the whole new object is valid', async () => {
  const voided = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { readinessLocal: true } } }
  })
  voided.state.applied = { generation: 3, flags: { readinessLocal: false } }
  const { result, lines } = run(parseCellFlagsRequest(values({ 'expected-generation': '7' })), voided)
  assert.equal((await result).written, true)
  assert.ok(lines.some((line) => line.event === 'orca_relay_cell_flags_repairing_unapplied_object'))
})

test('a flip back records db in Postgres only after the cell has leased every control', async () => {
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { admitMode: 'reserve' } } },
    reregisteringPolls: 3
  })
  fake.state.directorAdmitMode = 'reserve'
  const request = parseCellFlagsRequest(values({ ...DIRECTOR, set: 'admitMode=default', 'expected-generation': '7' }))
  assert.equal((await run(request, fake).result).written, true)
  assert.deepEqual(fake.state.order, ['file:db', 'director:db'])
  assert.equal(fake.state.reregisteringPolls, -1)
})

test('the flip-back wait scales with the control count and the switch-file pace', () => {
  assert.equal(reregisterWaitMs({ runtime: { controls: 100 } }), REREGISTER_WAIT_MIN_MS)
  // 1,500 controls at the default 3 lanes: 1,667 s.
  assert.equal(reregisterWaitMs({ runtime: { controls: 1_500 } }), 1_666_667)
  assert.equal(
    reregisterWaitMs({ runtime: { controls: 1_500 }, flagsApplied: { flags: { reregisterInFlight: 10 } } }),
    // The cell caps 10 at its US pool of 10 less two.
    625_000
  )
  assert.equal(reregisterWaitMs({ runtime: { controls: 3_000 } }), REREGISTER_WAIT_MAX_MS)
})

test('the wait counts the lanes the cell actually uses', () => {
  assert.equal(reregisterLanes({ region: 'us-central1' }), 3)
  assert.equal(reregisterLanes({ region: 'asia-east2' }), 5)
  assert.equal(reregisterLanes({ region: 'us-central1', flagsApplied: { flags: { reregisterInFlight: 16 } } }), 8)
  assert.equal(reregisterLanes({ region: 'asia-east2', flagsApplied: { flags: { reregisterInFlight: 16 } } }), 14)
  // The pool the cell reports wins over the deployed-size table.
  assert.equal(reregisterLanes({ region: 'us-central1', databasePoolMax: 22 }), 7)
  assert.equal(reregisterLanes({ region: 'asia-east2', databasePoolMax: 12, flagsApplied: { flags: { reregisterInFlight: 16 } } }), 10)
  assert.equal(reregisterLanes({ region: 'asia-east2', databasePoolMax: 'x' }), 5)
})

test('a tripped cell takes no write that keeps reserve, only one that also says db', async () => {
  const stored = { generation: '7', object: { v: 1, cellId: CELL, flags: { admitMode: 'reserve' } } }
  const tripped = () => fakeGoogleAndCell({ stored, effectiveOverride: 'db' })
  for (const set of ['readinessLocal=true', 'reregisterInFlight=4']) {
    const fake = tripped()
    const request = parseCellFlagsRequest(values({ set, 'expected-generation': '7' }))
    await assert.rejects(run(request, fake).result, /tripped its dead-man[\s\S]*admitMode=db,reregisterInFlight=N/)
    assert.deepEqual(fake.state.writes, [])
  }
  const fake = tripped()
  fake.state.directorAdmitMode = 'reserve'
  const request = parseCellFlagsRequest(
    values({ ...DIRECTOR, set: 'admitMode=db,reregisterInFlight=4', 'expected-generation': '7' })
  )
  assert.equal((await run(request, fake).result).written, true)
  assert.deepEqual(fake.state.writes[0].object.flags, { admitMode: 'db', reregisterInFlight: 4 })
})

test('a migration opened during the cache wait puts Postgres back to db', async () => {
  const fake = fakeGoogleAndCell({ refuseReservePost: { post: 2, error: 'cell_has_open_migration' } })
  const request = parseCellFlagsRequest(values({ ...RESERVE, set: 'admitMode=reserve' }))
  await assert.rejects(run(request, fake).result, /cell_has_open_migration/)
  assert.deepEqual(fake.state.order, ['director:reserve', 'director:db'])
  assert.deepEqual(fake.state.writes, [])
})

test('break glass refuses a cell that answers or that the director still hears', async () => {
  const glass = { ...RESERVE, set: 'admitMode=default', 'expected-generation': '7', 'break-glass': `BREAK GLASS ${CELL}` }
  const stored = { generation: '7', object: { v: 1, cellId: CELL, flags: { admitMode: 'reserve' } } }
  const answering = fakeGoogleAndCell({ stored })
  await assert.rejects(run(parseCellFlagsRequest(values(glass)), answering).result, /answers runtime-status/)
  const heard = fakeGoogleAndCell({ stored, heartbeatFresh: true })
  const inner = heard.fetchImpl
  heard.fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status') throw new Error('connect refused')
    return await inner(url, init)
  }
  await assert.rejects(run(parseCellFlagsRequest(values(glass)), heard).result, /still sees heartbeats/)
  assert.deepEqual(heard.state.writes, [])
  assert.deepEqual(answering.state.writes, [])
})

test('a flip back that outlasts its wait keeps Postgres on reserve and says how to finish', async () => {
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { admitMode: 'reserve' } } },
    reregisteringPolls: Number.POSITIVE_INFINITY,
    controls: 1_500
  })
  fake.state.directorAdmitMode = 'reserve'
  const request = parseCellFlagsRequest(values({ ...DIRECTOR, set: 'admitMode=default', 'expected-generation': '7' }))
  const { lines, result } = run(request, fake)
  await assert.rejects(result, /after 1666667 ms[\s\S]*Run again with --set admitMode=db[\s\S]*--set admitMode=db,reregisterInFlight=N/)
  assert.deepEqual(fake.state.order, ['file:db'])
  assert.equal(lines.find((line) => line.event === 'orca_relay_cell_reregistration_wait')?.waitMs, 1_666_667)
})

test('break glass records db for a cell that cannot answer, typed for that cell only', async () => {
  const glass = { ...RESERVE, set: 'admitMode=default', 'expected-generation': '7' }
  assert.throws(() => parseCellFlagsRequest(values({ ...glass, 'break-glass': 'BREAK GLASS production-gce-c27' })), /break glass requires/)
  assert.throws(
    () => parseCellFlagsRequest(values({ ...glass, set: 'admitMode=default,readinessLocal=true', 'break-glass': `BREAK GLASS ${CELL}` })),
    /on its own/
  )
  const fake = fakeGoogleAndCell({
    stored: { generation: '7', object: { v: 1, cellId: CELL, flags: { admitMode: 'reserve', readinessLocal: true } } }
  })
  fake.state.directorAdmitMode = 'reserve'
  const inner = fake.fetchImpl
  fake.fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/v1/admin/runtime-status') throw new Error('connect refused')
    return await inner(url, init)
  }
  const { result, lines } = run(parseCellFlagsRequest(values({ ...glass, 'break-glass': `BREAK GLASS ${CELL}` })), fake)
  assert.equal((await result).written, true)
  assert.deepEqual(fake.state.writes[0].object.flags, { readinessLocal: true })
  assert.deepEqual(fake.state.order, ['file:db', 'director:db'])
  assert.equal(lines.at(-1).event, 'orca_relay_cell_admit_mode_break_glass')
})

