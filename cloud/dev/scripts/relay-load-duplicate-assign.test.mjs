import assert from 'node:assert/strict'
import test from 'node:test'
import { proveRelayLoadDuplicateAssign } from './relay-load-duplicate-assign.mjs'

const c2 = 'https://c2.relay-staging.onorca.dev'
const c3 = 'https://c3.relay-staging.onorca.dev'

function pair(relayHostId, answers, { twinFails = false } = {}) {
  const queue = [...answers]
  const log = { primary: [], twin: [], twinShutdowns: 0 }
  const primary = {
    relayHostId,
    requestAssignment: async () => {
      const answer = queue.shift()
      if (answer instanceof Error) throw answer
      return answer
    },
    connect: async (assignment) => {
      log.primary.push(assignment)
    }
  }
  const twin = {
    connect: async (assignment) => {
      if (twinFails) throw new Error('control closed: 4409 wrong cell')
      log.twin.push(assignment)
    },
    shutdown: async () => {
      log.twinShutdowns++
    }
  }
  return { pair: { primary, twin }, log }
}

const failureReason = (error) => (error.message.startsWith('control closed: 4409') ? 'control_close_4409' : 'other')

test('counts same-epoch splits, joins the second cell with a twin, then lets it go', async () => {
  const split = pair('aaaaaaaaaaaaaaaa', [
    { cellUrl: c2, assignmentEpoch: 5 },
    { cellUrl: c3, assignmentEpoch: 5 }
  ])
  const same = pair('bbbbbbbbbbbbbbbb', [
    { cellUrl: c2, assignmentEpoch: 3 },
    { cellUrl: c2, assignmentEpoch: 3 }
  ])
  const delays = []
  const result = await proveRelayLoadDuplicateAssign({
    pairs: [split.pair, same.pair],
    holdMs: 20_000,
    delay: async (ms) => {
      delays.push(ms)
    },
    failureReason
  })

  assert.equal(result.probes, 2)
  assert.equal(result.bothAnswered, 2)
  assert.equal(result.splitCells, 1)
  assert.equal(result.sameEpochSplits, 1)
  assert.equal(result.joinedBoth, 1)
  assert.deepEqual(result.splits, [
    {
      relayHostId: 'aaaaaaaaaaaaaaaa',
      first: { cellUrl: c2, assignmentEpoch: 5 },
      second: { cellUrl: c3, assignmentEpoch: 5 }
    }
  ])
  assert.deepEqual(split.log.primary, [{ cellUrl: c2, assignmentEpoch: 5 }])
  assert.deepEqual(split.log.twin, [{ cellUrl: c3, assignmentEpoch: 5 }])
  assert.equal(split.log.twinShutdowns, 1)
  assert.deepEqual(same.log.twin, [])
  assert.deepEqual(delays, [20_000])
})

test('a split at different epochs is not a same-epoch split', async () => {
  const split = pair('cccccccccccccccc', [
    { cellUrl: c2, assignmentEpoch: 5 },
    { cellUrl: c3, assignmentEpoch: 6 }
  ])
  const result = await proveRelayLoadDuplicateAssign({
    pairs: [split.pair],
    holdMs: 1_000,
    delay: async () => undefined,
    failureReason
  })
  assert.equal(result.splitCells, 1)
  assert.equal(result.sameEpochSplits, 0)
})

test('a refused second assign still connects the host once and holds nothing', async () => {
  const refused = pair('dddddddddddddddd', [
    { cellUrl: c2, assignmentEpoch: 2 },
    new Error('relay assignment failed: 503')
  ])
  const delays = []
  const result = await proveRelayLoadDuplicateAssign({
    pairs: [refused.pair],
    holdMs: 20_000,
    delay: async (ms) => {
      delays.push(ms)
    },
    failureReason
  })
  assert.equal(result.bothAnswered, 0)
  assert.deepEqual(result.refusalsByReason, { other: 1 })
  assert.deepEqual(refused.log.primary, [{ cellUrl: c2, assignmentEpoch: 2 }])
  assert.deepEqual(delays, [])
})

test('a twin the second cell refuses is counted, not joined', async () => {
  const split = pair(
    'eeeeeeeeeeeeeeee',
    [
      { cellUrl: c2, assignmentEpoch: 5 },
      { cellUrl: c3, assignmentEpoch: 5 }
    ],
    { twinFails: true }
  )
  const result = await proveRelayLoadDuplicateAssign({
    pairs: [split.pair],
    holdMs: 20_000,
    delay: async () => undefined,
    failureReason
  })
  assert.equal(result.joinedBoth, 0)
  assert.deepEqual(result.connectFailuresByReason, { control_close_4409: 1 })
  assert.equal(split.log.twinShutdowns, 0)
})
