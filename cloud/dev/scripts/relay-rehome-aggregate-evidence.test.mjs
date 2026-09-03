import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseRegionalRehomeInventory } from './relay-rehome-aggregate-evidence.mjs'

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
    oldestActiveAgeMs: 30_000
  })
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
