import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizePlan, summarize } from './capture-terraform-plan-baseline.mjs'

test('normalizes, sorts, and drops forgets so a removed block cannot skew equivalence', () => {
  const changes = normalizePlan({
    resource_changes: [
      { address: 'b.two', change: { actions: ['update'], before: { x: 1 }, after: { x: 2 } } },
      { address: 'a.one', change: { actions: ['forget'], before: {}, after: null } },
      { address: 'c.three', change: { actions: ['delete', 'create'], before: {}, after: {}, after_unknown: { id: true } } }
    ]
  })
  assert.deepEqual(changes.map((change) => change.address), ['b.two', 'c.three'])
  assert.deepEqual(summarize(changes), { create: 0, update: 1, delete: 0, replace: 1, 'no-op': 0, read: 0 })
})
