import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  operateCellFlags,
  parseCellFlagsRequest,
  READ_BACK_TIMEOUT_MS,
  WRITE_CONFIRMATION
} from './operate-relay-cell-flags.mjs'

const CELL = 'production-gce-c26'
const values = (overrides = {}) => ({
  mode: 'write',
  'cell-id': CELL,
  'cell-origin': 'https://c26.relay.onorca.dev',
  'project-id': 'onorca-cloud',
  'readiness-local': 'true',
  'ticket-check': 'off',
  'expected-generation': '0',
  confirmation: `${WRITE_CONFIRMATION} ${CELL}`,
  ...overrides
})

// A cell whose runtime status applies whatever was written, after `applyAfterPolls` polls.
function fakeGoogleAndCell({ stored = null, applyAfterPolls = 2, role = 'cell', cellId = CELL } = {}) {
  const state = { stored, writes: [], polls: 0, applied: { generation: 0, flags: { readinessLocal: false, ticketCheck: 'off' } } }
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url)
    if (target.pathname === '/v1/admin/runtime-status') {
      state.polls += 1
      if (state.stored && state.polls > applyAfterPolls) {
        state.applied = { generation: Number(state.stored.generation), flags: state.stored.object.flags }
      }
      return Response.json({ v: 1, role, cellId, flagsApplied: state.applied })
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
  assert.throws(() => parseCellFlagsRequest(values({ 'ticket-check': 'enforce' })), /ticket-check/)
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
  assert.deepEqual(lines[0].desired.flags, { readinessLocal: true, ticketCheck: 'off' })
})

test('writes with compare-and-swap, records who wrote it, and waits for the cell to apply it', async () => {
  const fake = fakeGoogleAndCell()
  const { result, lines } = run(parseCellFlagsRequest(values()), fake)
  const outcome = await result
  assert.equal(outcome.written, true)
  assert.equal(outcome.generation, '1001')
  assert.deepEqual(outcome.applied, { generation: 1001, flags: { readinessLocal: true, ticketCheck: 'off' } })
  assert.deepEqual(fake.state.writes[0].metadata.metadata, { writtenBy: 'octocat', runId: '42', runAttempt: '1' })
  assert.deepEqual(fake.state.writes[0].object, {
    v: 1,
    cellId: CELL,
    flags: { readinessLocal: true, ticketCheck: 'off' }
  })
  assert.deepEqual(lines.map((line) => line.event), [
    'orca_relay_cell_flags_plan',
    'orca_relay_cell_flags_written',
    'orca_relay_cell_flags_applied_read_back'
  ])
  // Flip back: the next write must name the generation just written.
  const back = run(
    parseCellFlagsRequest(values({ 'readiness-local': 'false', 'expected-generation': '1001' })),
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
