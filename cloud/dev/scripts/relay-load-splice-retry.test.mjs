import assert from 'node:assert/strict'
import test from 'node:test'
import {
  holdRelayLoadSplice,
  relayLoadSpliceFailureReason,
  relayLoadSpliceReopenSummary
} from './relay-load-splice-retry.mjs'

const noDelay = async () => undefined

test('without retries the first splice failure still fails the run', async () => {
  await assert.rejects(
    holdRelayLoadSplice({
      open: async () => { throw new Error('splice closed: 1006 ') },
      retryMaxMs: 0,
      stopping: () => false,
      delay: noDelay
    }),
    /splice closed: 1006/
  )
})

test('with retries a closed splice reopens and its reasons are counted', async () => {
  const failures = []
  const waits = []
  let attempts = 0
  const result = await holdRelayLoadSplice({
    open: async () => {
      attempts++
      if (attempts === 1) throw new Error('splice closed: 1006 ')
      if (attempts === 2) throw new Error('Unexpected server response: 429')
      return 'held'
    },
    retryMaxMs: 2_000,
    stopping: () => false,
    onFailure: (reason) => failures.push(reason),
    delay: async (ms) => { waits.push(ms) },
    random: () => 0.5
  })
  assert.equal(result, 'held')
  assert.deepEqual(failures, ['closed_1006', 'http_429'])
  assert.deepEqual(waits, [1_000, 1_000])
})

test('a failure during shutdown is not counted and does not retry', async () => {
  let stopping = false
  const failures = []
  const result = await holdRelayLoadSplice({
    open: async () => { stopping = true; throw new Error('splice closed: 1000 ') },
    retryMaxMs: 1_000,
    stopping: () => stopping,
    onFailure: (reason) => failures.push(reason),
    delay: noDelay
  })
  assert.equal(result, undefined)
  assert.deepEqual(failures, [])
})

test('failure reasons bucket close codes, HTTP statuses and a missing control', () => {
  assert.equal(relayLoadSpliceFailureReason(new Error('splice closed: 4409 demoted')), 'closed_4409')
  assert.equal(relayLoadSpliceFailureReason(new Error('Unexpected server response: 503')), 'http_503')
  assert.equal(relayLoadSpliceFailureReason(new Error('active control required for splice')), 'no_active_control')
  assert.equal(relayLoadSpliceFailureReason(new Error('relay frame timeout')), 'other')
})

test('the reopen summary reports quantiles and splices still waiting', () => {
  assert.deepEqual(relayLoadSpliceReopenSummary([300, 100, 200], 1), {
    reopened: 3,
    awaiting: 1,
    p50Ms: 200,
    p95Ms: 300,
    maxMs: 300
  })
  assert.deepEqual(relayLoadSpliceReopenSummary([], 0), {
    reopened: 0,
    awaiting: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null
  })
})
