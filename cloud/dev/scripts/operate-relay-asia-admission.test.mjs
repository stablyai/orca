import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  operateRelayAsiaAdmission,
  parseRelayAsiaAdmissionArguments
} from './operate-relay-asia-admission.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const membershipDigest = (membership) =>
  createHash('sha256').update(JSON.stringify(membership)).digest('hex')

function harness(initialSelector, runtimeDigests = {}, runtimeRegions = {}) {
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
        region: runtimeRegions[`production-gce-${cell}`] ?? 'asia-east2',
        imageDigest: runtimeDigests[`production-gce-${cell}`] ?? digest,
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

const launchCells = ['production-gce-c27', 'production-gce-c28', 'production-gce-c29']

function admissionArguments(environment, mode, cellIds) {
  return [
    '--environment', environment, '--mode', mode, '--cell-ids', cellIds,
    '--image-digest', digest, '--expected-generation', '9', '--attempt-id', 'asia_wave_9'
  ]
}

test('accepts only reviewed Asia admission waves', () => {
  const accepted = [
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['inspect', 'production-gce-c30'],
    ['inspect', 'production-gce-c31'],
    ['verify', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['verify', 'production-gce-c30'],
    ['verify', 'production-gce-c31'],
    ['initialize', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['register', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['register', 'production-gce-c30'],
    ['registered', 'production-gce-c30'],
    ['register', 'production-gce-c31'],
    ['registered', 'production-gce-c31'],
    ['promote', 'production-gce-c27'],
    ['promote', 'production-gce-c28,production-gce-c29'],
    ['promote', 'production-gce-c30'],
    ['recover-promotion', 'production-gce-c30'],
    ['promote', 'production-gce-c31'],
    ['recover-promotion', 'production-gce-c31'],
    ['rollback', 'production-gce-c27'],
    ['rollback', 'production-gce-c28,production-gce-c29'],
    ['rollback', 'production-gce-c30'],
    ['rollback', 'production-gce-c31'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31,production-gce-c32,production-gce-c33'],
    ...['production-gce-c32', 'production-gce-c33'].flatMap((cellId) => [
      'inspect', 'verify', 'register', 'registered', 'promote', 'recover-promotion', 'rollback'
    ].map((mode) => [mode, cellId])),
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31,production-gce-c32,production-gce-c33']
  ]
  for (const [mode, cellIds] of accepted) {
    assert.deepEqual(
      parseRelayAsiaAdmissionArguments(admissionArguments('production', mode, cellIds)).cells,
      cellIds.split(','),
      `${mode} ${cellIds}`
    )
  }
  const rejected = [
    ['initialize', 'production-gce-c30'],
    ['initialize', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['register', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['register', 'production-gce-c30,production-gce-c31'],
    ['register', 'production-gce-c29,production-gce-c30'],
    ['registered', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30'],
    ['inspect', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['initialize', 'production-gce-c32'],
    ['register', 'production-gce-c32,production-gce-c33'],
    ['register', 'production-gce-c31,production-gce-c32'],
    ['promote', 'production-gce-c32,production-gce-c33'],
    ['rollback', 'production-gce-c32,production-gce-c33'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30,production-gce-c31'],
    ['verify', 'production-gce-c30,production-gce-c31'],
    ['verify', 'production-gce-c27,production-gce-c30'],
    ['promote', 'production-gce-c27,production-gce-c30'],
    ['promote', 'production-gce-c28,production-gce-c29,production-gce-c30'],
    ['promote', 'production-gce-c30,production-gce-c31'],
    ['promote', 'production-gce-c34'],
    ['rollback', 'production-gce-c27,production-gce-c30'],
    ['rollback', 'production-gce-c30,production-gce-c31'],
    ['rollback', 'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30'],
    ['rollback', 'production-gce-c28,production-gce-c29,production-gce-c30'],
    ['rollback', 'production-gce-c29'],
    ['register', 'staging-gce-c4']
  ]
  for (const [mode, cellIds] of rejected) {
    assert.throws(
      () => parseRelayAsiaAdmissionArguments(admissionArguments('production', mode, cellIds)),
      /--cell-ids/,
      `${mode} ${cellIds}`
    )
  }
  assert.deepEqual(
    parseRelayAsiaAdmissionArguments(admissionArguments('staging', 'promote', 'staging-gce-c4')).cells,
    ['staging-gce-c4']
  )
  assert.throws(
    () => parseRelayAsiaAdmissionArguments(admissionArguments('staging', 'promote', 'production-gce-c30')),
    /--cell-ids are invalid/
  )
})

test('registers C30 alone beside the general launch cells', async () => {
  const subject = harness({
    generation: 9,
    membership: { existingOnly: [], migrationOnly: [], general: [...launchCells] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register', cells: ['production-gce-c30'],
    expectedGeneration: 9, imageDigest: digest, attemptId: 'asia_register_c30', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.deepEqual(request.body.cells, [{
    cellId: 'production-gce-c30', cellUrl: 'https://c30.relay.onorca.dev', region: 'asia-east2',
    capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
  }])
  assert.deepEqual(result.states, { 'production-gce-c30': 'migration-only' })
  assert.deepEqual(subject.selector().membership.general, launchCells)
})

test('registers C31 alone beside the general C27-C30', async () => {
  const general = [...launchCells, 'production-gce-c30']
  const subject = harness({
    generation: 11,
    membership: { existingOnly: [], migrationOnly: [], general: [...general] }
  })
  const result = await operateRelayAsiaAdmission({
    environment: 'production', mode: 'register', cells: ['production-gce-c31'],
    expectedGeneration: 11, imageDigest: digest, attemptId: 'asia_register_c31', token: 'not-logged'
  }, subject)
  const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
  assert.deepEqual(request.body.cells, [{
    cellId: 'production-gce-c31', cellUrl: 'https://c31.relay.onorca.dev', region: 'asia-east2',
    capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
  }])
  assert.deepEqual(result.states, { 'production-gce-c31': 'migration-only' })
  assert.deepEqual(subject.selector().membership.general, general)
})

const usRegions = { 'production-gce-c32': 'us-central1', 'production-gce-c33': 'us-central1' }

test('registers C32 and C33 one at a time in us-central1 at the Asia shape', async () => {
  const general = [...launchCells, 'production-gce-c30', 'production-gce-c31']
  for (const [cellId, generation] of [['production-gce-c32', 13], ['production-gce-c33', 15]]) {
    const hostname = cellId.split('-').at(-1)
    const subject = harness({
      generation, membership: { existingOnly: [], migrationOnly: [], general: [...general] }
    }, {}, usRegions)
    const result = await operateRelayAsiaAdmission({
      environment: 'production', mode: 'register', cells: [cellId],
      expectedGeneration: generation, imageDigest: digest, attemptId: `us_register_${hostname}`,
      token: 'not-logged'
    }, subject)
    const request = subject.requests.find(({ path }) => path.endsWith('/add-migration-cells'))
    assert.deepEqual(request.body.cells, [{
      cellId, cellUrl: `https://${hostname}.relay.onorca.dev`, region: 'us-central1',
      capacityRequests: 6_000, connectionHardCap: 3_000, connectionUnobservedBound: 60
    }])
    assert.deepEqual(result.states, { [cellId]: 'migration-only' })
    // A US cell whose runtime reports Asia is the wrong cell, not a US one.
    await assert.rejects(operateRelayAsiaAdmission({
      environment: 'production', mode: 'register', cells: [cellId],
      expectedGeneration: generation, imageDigest: digest, attemptId: `us_register_${hostname}`,
      token: 'not-logged'
    }, harness({
      generation, membership: { existingOnly: [], migrationOnly: [], general: [...general] }
    })), new RegExp(`${cellId} runtime does not match`))
  }
})

test('promotes a US cell without the Asia launch order, which still binds Asia cells', async () => {
  const selector = (cellId) => ({
    generation: 14,
    membership: {
      existingOnly: [],
      migrationOnly: [cellId, 'production-gce-c27', 'production-gce-c28'].sort(),
      general: ['production-gce-c29']
    }
  })
  const config = (cellId) => ({
    environment: 'production', mode: 'promote', cells: [cellId],
    expectedGeneration: 14, imageDigest: digest, attemptId: 'us_promote_wave', token: 'not-logged'
  })
  const result = await operateRelayAsiaAdmission(
    config('production-gce-c32'), harness(selector('production-gce-c32'), {}, usRegions)
  )
  assert.deepEqual(result.states, { 'production-gce-c32': 'general' })
  await assert.rejects(
    operateRelayAsiaAdmission(config('production-gce-c31'), harness(selector('production-gce-c31'))),
    /C27 canary/
  )
})

test('requires the C27 canary to be general before promoting C30', async () => {
  const selector = (general) => ({
    generation: 10,
    membership: {
      existingOnly: [],
      migrationOnly: ['production-gce-c30', ...launchCells.filter((cell) => !general.includes(cell))].sort(),
      general
    }
  })
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c30'],
    expectedGeneration: 10, imageDigest: digest, attemptId: 'asia_promote_c30', token: 'not-logged'
  }
  await assert.rejects(
    operateRelayAsiaAdmission(config, harness(selector(['production-gce-c28', 'production-gce-c29']))),
    /C27 canary/
  )
  await assert.rejects(
    operateRelayAsiaAdmission(config, harness(selector(['production-gce-c27', 'production-gce-c29']))),
    /every launch cell to be general/
  )
  const subject = harness(selector([...launchCells]))
  const result = await operateRelayAsiaAdmission(config, subject)
  assert.deepEqual(result.states, { 'production-gce-c30': 'general' })
  assert.equal(subject.requests.filter(({ path }) => path === '/v1/admin/cell-status').length, 1)
})

test('promotes C30 on its own digest while the launch cells serve another', async () => {
  const c30Digest = `sha256:${'b'.repeat(64)}`
  const selector = {
    generation: 10,
    membership: { existingOnly: [], migrationOnly: ['production-gce-c30'], general: [...launchCells] }
  }
  const config = {
    environment: 'production', mode: 'promote', cells: ['production-gce-c30'],
    expectedGeneration: 10, imageDigest: c30Digest, attemptId: 'asia_promote_c30', token: 'not-logged'
  }
  const digests = { 'production-gce-c30': c30Digest }
  const result = await operateRelayAsiaAdmission(config, harness(selector, digests))
  assert.deepEqual(result.states, { 'production-gce-c30': 'general' })
  await assert.rejects(
    operateRelayAsiaAdmission({ ...config, imageDigest: digest }, harness(selector, digests)),
    /production-gce-c30 runtime does not match/
  )
})

const admissionWorkflow = readRelayWorkflow('operate-relay-asia-admission.yml')

function workflowBlock(first, last) {
  const start = admissionWorkflow.indexOf(first)
  const end = admissionWorkflow.indexOf(last, start)
  assert.ok(start !== -1 && end !== -1, first)
  return admissionWorkflow.slice(start, end + last.length).replace(/^ {10}/gm, '')
}

// Runs the workflow's own promotion input block, so each wave's canary routing is what ships.
function promotionOutputs(cellIds) {
  const temp = mkdtempSync(join(tmpdir(), 'relay-admission-inputs-'))
  try {
    const output = join(temp, 'output')
    const result = spawnSync('bash', ['-c', workflowBlock(
      'set -euo pipefail\n          test -n "${DEPLOY_WORKLOAD_IDENTITY_PROVIDER}"',
      '} >> "${GITHUB_OUTPUT}"'
    )], {
      env: {
        ...process.env, GITHUB_OUTPUT: output, DEPLOY_WORKLOAD_IDENTITY_PROVIDER: 'provider',
        DEPLOY_SERVICE_ACCOUNT: 'account', IMAGE_DIGEST: digest, OPERATION_MODE: 'promote',
        EXPECTED_SELECTOR_GENERATION: '9', SELECTOR_ATTEMPT_ID: 'promote_wave_9',
        OPERATION_CONFIRMATION: 'PROMOTE_ASIA_GENERAL', TARGET_ENVIRONMENT: 'production',
        TARGET_CELL_IDS: cellIds, EXPECTED_SELECTOR_MEMBERSHIP_SHA256: '', DIRECTOR_IMAGE_DIGEST: '',
        EVIDENCE_RUN_ID: '', EVIDENCE_RUN_ATTEMPT: ''
      },
      encoding: 'utf8'
    })
    if (result.status !== 0) return null
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n')
      .map((line) => line.split('=')))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

test('runs each later cell\'s own canary with load aimed at that cell\'s region', () => {
  for (const [cellId, region] of [
    ['production-gce-c30', 'asia-east2'], ['production-gce-c31', 'asia-east2'],
    ['production-gce-c32', 'us-central1'], ['production-gce-c33', 'us-central1']
  ]) {
    const outputs = promotionOutputs(cellId)
    assert.equal(outputs?.canary, 'true', cellId)
    assert.equal(outputs.canary_cell, cellId)
    assert.equal(outputs.canary_region, region, cellId)
    assert.equal(outputs.evidence_kind, 'none')
  }
  assert.equal(promotionOutputs('production-gce-c34'), null)
  assert.equal(promotionOutputs('production-gce-c32,production-gce-c33'), null)
  const canaryStart = workflowBlock('case "${CANARY_CELL}" in', '\n          esac')
  for (const cellId of ['production-gce-c32', 'production-gce-c33']) {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c',
      `${canaryStart}\necho "\${verify_cells} \${expected_states}"`], {
      env: { ...process.env, CANARY_CELL: cellId }, encoding: 'utf8'
    })
    assert.equal(result.stdout.trim(), `${cellId} {"${cellId}":"general"}`)
  }
  assert.match(admissionWorkflow, /--preferred-region "\$\{CANARY_REGION\}"/)
  assert.match(admissionWorkflow, /CANARY_REGION: \$\{\{ steps\.inputs\.outputs\.canary_region \}\}/)
})
