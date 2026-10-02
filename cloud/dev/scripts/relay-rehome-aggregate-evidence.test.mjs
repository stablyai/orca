import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRegionalRehomeInventory } from './relay-rehome-aggregate-evidence.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'

const now = Date.parse('2026-08-14T12:00:00Z')

test('selects the newest fresh aggregate-only regional rehome inventory', () => {
  const result = parseRegionalRehomeInventory([
    {
      timestamp: '2026-08-14T11:58:00Z',
      textPayload: '[orca-relay] regional rehome inventory active=2 awaitingReceipt=1 targetRegistered=1 completedLast24Hours=9 abortedLast24Hours=0 oldestActiveAgeMs=30000'
    },
    {
      timestamp: '2026-08-14T11:50:00Z',
      textPayload: '[orca-relay] regional rehome inventory active=1 awaitingReceipt=0 targetRegistered=1 completedLast24Hours=8 abortedLast24Hours=0 oldestActiveAgeMs=none'
    }
  ], { now, maxAgeMs: 5 * 60_000 })
  assert.deepEqual(result, {
    timestamp: Date.parse('2026-08-14T11:58:00Z'),
    active: 2,
    awaitingReceipt: 1,
    targetRegistered: 1,
    completedLast24Hours: 9,
    abortedLast24Hours: 0,
    hostNotArrivedLast24Hours: null,
    oldestActiveAgeMs: 30_000
  })
})

test('reads a line the director grew a field on, wherever the field sits', () => {
  const result = parseRegionalRehomeInventory([{
    timestamp: '2026-08-14T11:58:00Z',
    textPayload:
      '[orca-relay] regional rehome inventory hostNotArrivedLast24Hours=4 active=2' +
      ' awaitingReceipt=1 targetRegistered=1 completedLast24Hours=9 abortedLast24Hours=7' +
      ' oldestActiveAgeMs=30000 someFieldFromALaterRelease=11'
  }], { now, maxAgeMs: 5 * 60_000 })
  assert.equal(result.hostNotArrivedLast24Hours, 4)
  assert.equal(result.abortedLast24Hours, 7)
  assert.equal(result.oldestActiveAgeMs, 30_000)
})

test('reports an unmeasured host-not-arrived count as absent, not as zero', () => {
  const [withField, withoutField] = ['4', null].map((value) =>
    parseRegionalRehomeInventory([{
      timestamp: '2026-08-14T11:58:00Z',
      textPayload:
        '[orca-relay] regional rehome inventory active=0 awaitingReceipt=0 targetRegistered=0' +
        ' completedLast24Hours=0 abortedLast24Hours=0 oldestActiveAgeMs=none' +
        (value === null ? '' : ` hostNotArrivedLast24Hours=${value}`)
    }], { now, maxAgeMs: 5 * 60_000 })
  )
  assert.equal(withField.hostNotArrivedLast24Hours, 4)
  assert.equal(withoutField.hostNotArrivedLast24Hours, null)
})

test('rejects stale, malformed, and identity-bearing lookalikes', () => {
  assert.throws(() => parseRegionalRehomeInventory([{
    timestamp: '2026-08-14T11:00:00Z',
    textPayload: '[orca-relay] regional rehome inventory active=0 awaitingReceipt=0 targetRegistered=0 completedLast24Hours=0 abortedLast24Hours=0 oldestActiveAgeMs=none'
  }], { now, maxAgeMs: 5 * 60_000 }), /stale/)
  assert.throws(() => parseRegionalRehomeInventory([{
    timestamp: '2026-08-14T11:59:00Z',
    textPayload: '[orca-relay] regional rehome inventory active=0 hostId=secret'
  }], { now }), /no aggregate/)
})

test('keeps out an identity-bearing field riding along on a complete line', () => {
  const complete =
    '[orca-relay] regional rehome inventory active=0 awaitingReceipt=0 targetRegistered=0' +
    ' completedLast24Hours=0 abortedLast24Hours=0 oldestActiveAgeMs=none'
  for (const extra of [' hostId=secret', ' userId=someone@example.test', ' note=a b']) {
    assert.throws(
      () => parseRegionalRehomeInventory(
        [{ timestamp: '2026-08-14T11:59:00Z', textPayload: complete + extra }],
        { now }
      ),
      /no aggregate/,
      extra
    )
  }
})

test('refuses a line missing a required field, or repeating one', () => {
  const missing =
    '[orca-relay] regional rehome inventory active=0 awaitingReceipt=0 targetRegistered=0' +
    ' completedLast24Hours=0 oldestActiveAgeMs=none'
  assert.throws(
    () => parseRegionalRehomeInventory(
      [{ timestamp: '2026-08-14T11:59:00Z', textPayload: missing }],
      { now }
    ),
    /no aggregate/
  )
  assert.throws(
    () => parseRegionalRehomeInventory(
      [{ timestamp: '2026-08-14T11:59:00Z', textPayload: `${missing} abortedLast24Hours=0 abortedLast24Hours=1` }],
      { now }
    ),
    /no aggregate/
  )
  assert.throws(
    () => parseRegionalRehomeInventory(
      [{
        timestamp: '2026-08-14T11:59:00Z',
        textPayload: missing.replace('active=0', 'active=none') + ' abortedLast24Hours=0'
      }],
      { now }
    ),
    /no aggregate/
  )
})

// The third edge of the chain the enable workflow depends on. The formatter is
// pinned against this parser in the relay package's inventory-line census; this
// pins the parser against the summary an operator reads, so a field that
// reaches the evidence JSON and stops there fails here.
test('publishes every parsed counter in the operator step summary', () => {
  const job = readRelayWorkflow('operate-relay-production-rehome-job.yml')
  // The jq program and the file it reads sit on separate continuation lines, so
  // match the whole render rather than one line of it.
  const summary = /jq -r '([^']*)' \\\n\s*"\$\{RUNNER_TEMP\}\/relay-rehome-inventory\.json"/.exec(job)?.[1]
  assert.ok(summary, 'the rehome job no longer renders the inventory evidence')
  const evidence = parseRegionalRehomeInventory([{
    timestamp: '2026-08-14T11:58:00Z',
    textPayload:
      '[orca-relay] regional rehome inventory active=0 awaitingReceipt=0 targetRegistered=0' +
      ' completedLast24Hours=0 abortedLast24Hours=0 hostNotArrivedLast24Hours=0 oldestActiveAgeMs=none'
  }], { now, maxAgeMs: 5 * 60_000 })
  for (const key of Object.keys(evidence)) {
    if (key === 'timestamp') continue
    assert.ok(summary.includes(`.${key}`), `${key} is missing from the step summary`)
  }
})
