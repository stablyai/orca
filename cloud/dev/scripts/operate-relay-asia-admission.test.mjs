import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { operateRelayAsiaAdmission } from './operate-relay-asia-admission.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const membershipDigest = (membership) =>
  createHash('sha256').update(JSON.stringify(membership)).digest('hex')

function harness(initialSelector) {
  const initialMembership = structuredClone(initialSelector.membership)
  let selector = structuredClone(initialSelector)
  const intents = new Map()
  const requests = []
  let fetches = 0
  let failAfterIntent = false
  const post = async (url, body) => {
    const parsed = new URL(url)
    requests.push({ path: parsed.pathname, body })
    if (parsed.pathname === '/v1/admin/runtime-status') {
      const cell = parsed.hostname.split('.')[0]
      return {
        cellId: `production-gce-${cell}`,
        cellUrl: parsed.origin,
        region: 'asia-east2',
        imageDigest: digest,
        draining: false,
        connectionCapacity: { hardCap: 3_000, unobservedBound: 60 }
      }
    }
    if (parsed.pathname === '/v1/admin/cell-status') {
      return {
        status: {
          cellUrl: `https://${body.cellId.split('-').at(-1)}.relay.onorca.dev`,
          runtime: { heartbeatFresh: true, ready: true }
        }
      }
    }
    if (parsed.pathname.endsWith('/status')) {
      return { selector, intent: body.attemptId ? intents.get(body.attemptId) ?? null : null }
    }
    if (parsed.pathname.endsWith('/add-migration-cells')) {
      selector = {
        generation: selector.generation + 1,
        attemptId: body.attemptId,
        membership: {
          ...selector.membership,
          migrationOnly: [...selector.membership.migrationOnly, ...body.cells.map((cell) => cell.cellId)].sort()
        }
      }
    } else if (parsed.pathname.endsWith('/apply-staging-asia-proof')) {
      const membership = structuredClone(selector.membership)
      membership.migrationOnly = membership.migrationOnly.filter((cell) => cell !== 'staging-gce-c4')
      membership.general = membership.general.filter((cell) => cell !== 'staging-gce-c4')
      membership[body.state === 'general' ? 'general' : 'migrationOnly'].push('staging-gce-c4')
      selector = { generation: selector.generation + 1, attemptId: body.attemptId, membership }
    } else if (parsed.pathname.endsWith('/apply')) {
      if (
        body.expectedMembershipSha256 &&
        body.expectedMembershipSha256 !== membershipDigest(selector.membership)
      ) throw new Error('admission_selector_membership_mismatch')
      if (failAfterIntent) {
        failAfterIntent = false
        intents.set(body.attemptId, {
          state: 'unchanged',
          expectedGeneration: body.expectedGeneration,
          previousMembership: structuredClone(selector.membership),
          membership: structuredClone(body.membership)
        })
        throw new Error('failure after intent persistence')
      }
      selector = { generation: selector.generation + 1, attemptId: body.attemptId, membership: body.membership }
    } else throw new Error(`unexpected ${parsed.pathname}`)
    intents.set(body.attemptId, {
      state: 'committed', expectedGeneration: body.expectedGeneration,
      previousMembership: initialSelector.membership,
      membership: selector.membership
    })
    return { changed: true, selector }
  }
  const fetch = async () => {
    fetches++
    return new Response(null, { status: 200 })
  }
  const commitWithoutResponse = async (path, body) => {
    await post(`https://relay.onorca.dev${path}`, body)
    throw new Error('response lost after commit')
  }
  return {
    post, fetch, requests, commitWithoutResponse,
    failNextApplyAfterIntent: () => (failAfterIntent = true),
    apply: async (attemptId, membership) => await post(
      'https://relay.onorca.dev/v1/admin/admission-selector/apply',
      { attemptId, expectedGeneration: selector.generation, membership }
    ),
    fetchCount: () => fetches, selector: () => selector
  }
}

const baseSelector = {
  generation: 7,
  membership: { existingOnly: [], migrationOnly: [], general: ['production-gce-c26'] }
}

test('inspects generation zero without requiring target registration or making a mutation', async () => {
  const subject = harness({
    generation: 0,
    membership: {
      existingOnly: ['staging-gce-c3'],
      migrationOnly: [],
      general: ['staging-gce-c1', 'staging-gce-c2']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'inspect', cells: ['staging-gce-c4'],
    imageDigest: digest, token: 'not-logged'
  }, subject)
  assert.equal(result.generation, 0)
  assert.equal(result.states['staging-gce-c4'], 'absent')
  assert.deepEqual(result.membership, subject.selector().membership)
  assert.equal(result.membershipSha256, membershipDigest(subject.selector().membership))
  assert.deepEqual(subject.requests.map(({ path }) => path), [
    '/v1/admin/admission-selector/status'
  ])
})

test('initializes generation zero without changing membership', async () => {
  const membership = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const subject = harness({ generation: 0, membership })
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(membership),
    attemptId: 'asia_boundary_0', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/apply'))
  assert.deepEqual(request.body, {
    v: 1,
    attemptId: 'asia_boundary_0',
    expectedGeneration: 0,
    expectedMembershipSha256: membershipDigest(membership),
    membership
  })
  assert.equal(result.generation, 1)
  assert.equal(result.states['staging-gce-c4'], 'absent')
  assert.deepEqual(subject.selector().membership, membership)
})

test('retries the same fingerprint-bound initialization after intent persistence', async () => {
  const membership = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const subject = harness({ generation: 0, membership })
  subject.failNextApplyAfterIntent()
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(membership),
    attemptId: 'asia_boundary_intent_retry', token: 'not-logged'
  }, subject)
  const applies = subject.requests.filter(({ path }) => path.endsWith('/apply'))
  assert.equal(applies.length, 2)
  assert.deepEqual(applies[1].body, applies[0].body)
  assert.equal(result.recovered, true)
  assert.equal(result.generation, 1)
  assert.deepEqual(subject.selector().membership, membership)
})

test('recovers a committed generation-zero initialization', async () => {
  const membership = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const subject = harness({ generation: 0, membership })
  const config = {
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(membership),
    attemptId: 'asia_boundary_retry', token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/apply',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: 0,
      expectedMembershipSha256: membershipDigest(membership),
      membership
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 1)
  assert.deepEqual(subject.selector().membership, membership)
})

test('rejects generation-zero membership drift after inspect', async () => {
  const inspected = {
    existingOnly: ['staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1', 'staging-gce-c2']
  }
  const changed = {
    existingOnly: ['staging-gce-c2', 'staging-gce-c3'],
    migrationOnly: [],
    general: ['staging-gce-c1']
  }
  const subject = harness({ generation: 0, membership: changed })
  await assert.rejects(operateRelayAsiaAdmission({
    environment: 'staging', mode: 'initialize', cells: ['staging-gce-c4'],
    expectedGeneration: 0, imageDigest: digest,
    expectedMembershipSha256: membershipDigest(inspected),
    attemptId: 'asia_boundary_drift', token: 'not-logged'
  }, subject), /membership changed/)
  assert.equal(subject.requests.some(({ path }) => path.endsWith('/apply')), false)
})

test('registers all three Asia cells atomically with region and exact limits', async () => {
  const subject = harness(baseSelector)
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 7, imageDigest: digest, attemptId: 'asia_register_7', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.equal(request.body.cells.length, 3)
  assert.ok(request.body.cells.every((cell) =>
    cell.region === 'asia-east2' && cell.capacityRequests === 6_000 &&
    cell.connectionHardCap === 3_000 && cell.connectionUnobservedBound === 60
  ))
  assert.equal(result.generation, 8)
  assert.deepEqual(new Set(Object.values(result.states)), new Set(['migration-only']))
})

test('promotes the canary only after runtime and director-heartbeat checks', async () => {
  const subject = harness({
    generation: 8,
    membership: { existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26'] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'promote', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_promote_8', token: 'not-logged'
  }, subject)
  assert.equal(subject.fetchCount(), 2)
  assert.equal(result.states['production-gce-c27'], 'general')
})

test('checks registered migration-only cells before director configuration without requiring heartbeat', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [],
      migrationOnly: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
      general: ['production-gce-c26']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'registered',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 8, imageDigest: digest, token: 'not-logged'
  }, subject)
  assert.equal(subject.fetchCount(), 6)
  assert.equal(subject.requests.filter(({ path }) => path === '/v1/admin/cell-status').length, 0)
  assert.deepEqual(new Set(Object.values(result.states)), new Set(['migration-only']))
})

test('rolls back admission without requiring an unhealthy runtime to answer', async () => {
  const subject = harness({
    generation: 9,
    membership: { existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27'] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'rollback', cells: ['production-gce-c27'],
    expectedGeneration: 9, imageDigest: digest, attemptId: 'asia_rollback_9', token: 'not-logged'
  }, subject)
  assert.equal(subject.fetchCount(), 0)
  assert.equal(result.states['production-gce-c27'], 'migration-only')
})

test('uses the server-enforced C4-only route for staging proof transitions', async () => {
  const subject = harness({
    generation: 3,
    membership: {
      existingOnly: ['staging-gce-c1'],
      migrationOnly: [],
      general: ['staging-gce-c2', 'staging-gce-c4']
    }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'staging', mode: 'rollback', cells: ['staging-gce-c4'],
    expectedGeneration: 3, imageDigest: digest, attemptId: 'asia_staging_rollback',
    token: 'not-logged'
  }, subject)
  const request = subject.requests.find(
    ({ path }) => path.endsWith('/apply-staging-asia-proof')
  )
  assert.deepEqual(request.body, {
    v: 1,
    attemptId: 'asia_staging_rollback',
    expectedGeneration: 3,
    state: 'migration-only'
  })
  assert.deepEqual(subject.selector().membership, {
    existingOnly: ['staging-gce-c1'],
    migrationOnly: ['staging-gce-c4'],
    general: ['staging-gce-c2']
  })
  assert.equal(result.states['staging-gce-c4'], 'migration-only')
})

test('fails closed when the exact selector generation moved', async () => {
  const subject = harness(baseSelector)
  await assert.rejects(operateRelayAsiaAdmission({
    environment: 'production', mode: 'register',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 6, imageDigest: digest, attemptId: 'asia_register_6', token: 'not-logged'
  }, subject), /generation changed/)
  assert.equal(subject.fetchCount(), 0)
})

test('recovers a committed registration when the workflow retries the original generation', async () => {
  const subject = harness(baseSelector)
  const config = {
    environment: 'production', mode: 'register',
    cells: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
    expectedGeneration: 7, imageDigest: digest, attemptId: 'asia_register_retry',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/add-migration-cells',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: config.expectedGeneration,
      cells: config.cells.map((cellId) => ({ cellId }))
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 8)
})

test('recovers a committed promotion when the workflow retries the original generation', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_promote_retry',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/apply',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: config.expectedGeneration,
      membership: {
        existingOnly: [], migrationOnly: [],
        general: ['production-gce-c26', 'production-gce-c27']
      }
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 9)
  assert.equal(recovered.states['production-gce-c27'], 'general')
})

test('inspects an ambiguous promotion without creating a new transition', async () => {
  const untouched = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'recover-promotion', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_recover_promote',
    token: 'not-logged'
  }
  const absent = await operateRelayAsiaAdmission(config, untouched)
  assert.equal(absent.promoted, false)
  assert.equal(untouched.requests.some(({ path }) => path.endsWith('/apply')), false)

  const committed = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  await assert.rejects(committed.commitWithoutResponse('/v1/admin/admission-selector/apply', {
    v: 1,
    attemptId: config.attemptId,
    expectedGeneration: 8,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  }), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, committed)
  assert.equal(recovered.promoted, true)
  assert.equal(recovered.generation, 9)
})

test('treats an already rolled-back promotion as recovered', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'recover-promotion', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_recover_after_rollback',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse('/v1/admin/admission-selector/apply', {
    v: 1, attemptId: config.attemptId, expectedGeneration: 8,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  }), /response lost after commit/)
  await subject.apply('later_rollback', {
    existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
  })
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.promoted, false)
  assert.equal(recovered.generation, 10)
})

test('recovers a committed rollback when the workflow retries the original generation', async () => {
  const subject = harness({
    generation: 9,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  })
  const config = {
    environment: 'production', mode: 'rollback', cells: ['production-gce-c27'],
    expectedGeneration: 9, imageDigest: digest, attemptId: 'asia_rollback_retry',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse(
    '/v1/admin/admission-selector/apply',
    {
      v: 1,
      attemptId: config.attemptId,
      expectedGeneration: config.expectedGeneration,
      membership: {
        existingOnly: [], migrationOnly: ['production-gce-c27'],
        general: ['production-gce-c26']
      }
    }
  ), /response lost after commit/)
  const recovered = await operateRelayAsiaAdmission(config, subject)
  assert.equal(recovered.recovered, true)
  assert.equal(recovered.generation, 10)
  assert.equal(recovered.states['production-gce-c27'], 'migration-only')
})

test('rejects a committed transition retry after a later selector change', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
    }
  })
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c27'],
    expectedGeneration: 8, imageDigest: digest, attemptId: 'asia_stale_promote',
    token: 'not-logged'
  }
  await assert.rejects(subject.commitWithoutResponse('/v1/admin/admission-selector/apply', {
    v: 1, attemptId: config.attemptId, expectedGeneration: 8,
    membership: {
      existingOnly: [], migrationOnly: [], general: ['production-gce-c26', 'production-gce-c27']
    }
  }), /response lost after commit/)
  await subject.apply('later_rollback', {
    existingOnly: [], migrationOnly: ['production-gce-c27'], general: ['production-gce-c26']
  })
  await assert.rejects(
    operateRelayAsiaAdmission(config, subject),
    /does not match the requested Asia transition/
  )
})

test('requires the C27 canary before promoting C28 and C29', async () => {
  const subject = harness({
    generation: 8,
    membership: {
      existingOnly: [],
      migrationOnly: ['production-gce-c27', 'production-gce-c28', 'production-gce-c29'],
      general: ['production-gce-c26']
    }
  })
  await assert.rejects(operateRelayAsiaAdmission({
    environment: 'production', mode: 'promote',
    cells: ['production-gce-c28', 'production-gce-c29'], expectedGeneration: 8,
    imageDigest: digest, attemptId: 'asia_wave_before_canary', token: 'not-logged'
  }, subject), /C27 canary/)
})
