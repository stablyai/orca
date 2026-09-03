import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  addExactMigrationCells,
  applyExactAdmissionSelector,
  membershipWithStates,
  selectorAttemptId,
  transitionAdmissionSelector
} from './relay-admission-selector.mjs'

const initialMembership = {
  existingOnly: ['legacy'],
  migrationOnly: ['target'],
  general: ['general']
}

function selectorHarness({ ambiguous = null, generation = 1 } = {}) {
  let selector = { generation, attemptId: 'initial', membership: initialMembership }
  const intents = new Map()
  const requests = []
  let applies = 0
  const post = async (path, body) => {
    if (path.endsWith('/status')) {
      return {
        selector,
        intent: body.attemptId ? intents.get(body.attemptId) ?? null : null
      }
    }
    applies++
    requests.push(body)
    const before = selector
    const committed = {
      generation: body.expectedGeneration + 1,
      attemptId: body.attemptId,
      membership: body.membership
    }
    intents.set(body.attemptId, {
      attemptId: body.attemptId,
      expectedGeneration: body.expectedGeneration,
      intendedGeneration: committed.generation,
      previousMembership: before.membership,
      membership: body.membership,
      state: ambiguous === 'unchanged' ? 'unchanged' : 'committed'
    })
    if (ambiguous !== 'unchanged') selector = committed
    if (ambiguous) throw new Error('lost selector response')
    return { changed: true, selector }
  }
  return { post, selector: () => selector, applies: () => applies, requests }
}

test('derives deterministic attempts and applies exact selector transitions', async () => {
  const harness = selectorHarness()
  const desired = membershipWithStates(harness.selector(), { target: 'general' })
  assert.equal(
    selectorAttemptId(1, desired),
    selectorAttemptId(1, {
      existingOnly: ['legacy'],
      migrationOnly: [],
      general: ['target', 'general']
    })
  )
  const result = await transitionAdmissionSelector(harness.post, { target: 'general' })
  assert.equal(result.selector.generation, 2)
  assert.deepEqual(result.selector.membership.general, ['general', 'target'])
})

test('accepts only an exact committed result after an ambiguous response', async () => {
  const harness = selectorHarness({ ambiguous: 'committed' })
  const result = await applyExactAdmissionSelector(harness.post, {
    existingOnly: ['legacy', 'target'],
    migrationOnly: [],
    general: ['general']
  })
  assert.equal(result.recovered, true)
  assert.equal(harness.applies(), 1)
  assert.equal(result.selector.generation, 2)
})

test('binds a generation-zero cutover to the inspected membership', async () => {
  const harness = selectorHarness({ generation: 0 })
  await applyExactAdmissionSelector(
    harness.post,
    {
      existingOnly: ['legacy', 'target'],
      migrationOnly: [],
      general: ['general']
    },
    { requireBoundary: false }
  )
  assert.equal(
    harness.requests[0].expectedMembershipSha256,
    createHash('sha256').update(JSON.stringify(initialMembership)).digest('hex')
  )
})

test('stops on an unchanged ambiguous result without replaying', async () => {
  const harness = selectorHarness({ ambiguous: 'unchanged' })
  await assert.rejects(
    applyExactAdmissionSelector(harness.post, {
      existingOnly: ['legacy', 'target'],
      migrationOnly: [],
      general: ['general']
    }),
    /remained unchanged/
  )
  assert.equal(harness.applies(), 1)
  assert.equal(harness.selector().generation, 1)
})

test('never restores an existing-only cell', () => {
  assert.throws(
    () => membershipWithStates({ membership: initialMembership }, { legacy: 'general' }),
    /cannot re-enable/
  )
})

test('refuses an exact apply after the inspected selector changes', async () => {
  const harness = selectorHarness()
  await assert.rejects(
    applyExactAdmissionSelector(
      harness.post,
      {
        existingOnly: ['legacy', 'target'],
        migrationOnly: [],
        general: ['general']
      },
      {
        expectedCurrentSelector: {
          generation: 0,
          membership: {
            existingOnly: ['target'],
            migrationOnly: [],
            general: ['general', 'legacy']
          }
        }
      }
    ),
    /changed before exact apply/
  )
  assert.equal(harness.applies(), 0)
})

test('adds exact migration cells and recovers a committed response loss', async () => {
  let selector = { generation: 1, attemptId: 'initial', membership: initialMembership }
  const intents = new Map()
  let additions = 0
  const post = async (path, body) => {
    if (path.endsWith('/status')) {
      return {
        selector,
        intent: body.attemptId ? intents.get(body.attemptId) ?? null : null
      }
    }
    additions++
    selector = {
      generation: body.expectedGeneration + 1,
      attemptId: body.attemptId,
      membership: {
        ...selector.membership,
        migrationOnly: [
          ...selector.membership.migrationOnly,
          ...body.cells.map(({ cellId }) => cellId)
        ].sort()
      }
    }
    intents.set(body.attemptId, {
      attemptId: body.attemptId,
      expectedGeneration: body.expectedGeneration,
      intendedGeneration: selector.generation,
      membership: selector.membership,
      state: 'committed'
    })
    throw new Error('lost cell registration response')
  }
  const result = await addExactMigrationCells(post, {
    attemptId: 'add_cells_exact',
    cells: [
      {
        cellId: 'target-2',
        cellUrl: 'https://target-2.example.com',
        capacityRequests: 4_000,
        connectionHardCap: 600,
        connectionUnobservedBound: 60
      }
    ]
  })
  assert.equal(result.recovered, true)
  assert.equal(additions, 1)
  assert.deepEqual(result.selector.membership.migrationOnly, ['target', 'target-2'])
})

test('does not recover an attempt owned by another selector operation', async () => {
  const selector = {
    generation: 2,
    attemptId: 'selector_collision',
    membership: initialMembership
  }
  const post = async (path, body) => {
    if (path.endsWith('/status')) {
      return {
        selector,
        intent: body.attemptId
          ? {
              attemptId: body.attemptId,
              expectedGeneration: 1,
              intendedGeneration: 2,
              membership: initialMembership,
              state: 'committed'
            }
          : null
      }
    }
    throw new Error('admission_selector_attempt_mismatch')
  }
  await assert.rejects(
    addExactMigrationCells(post, {
      attemptId: 'selector_collision',
      cells: [
        {
          cellId: 'target-2',
          cellUrl: 'https://target-2.example.com',
          capacityRequests: 4_000,
          connectionHardCap: 600,
          connectionUnobservedBound: 60
        }
      ]
    }),
    /did not commit exactly/
  )
})
