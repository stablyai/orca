import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { relayWorkflowUrl } from './relay-repository.mjs'
import { prepareCapacityCanary } from './prepare-relay-capacity-canary.mjs'

function harness(initialState, options = {}) {
  const {
    generation = 4,
    ambiguousCellState = false,
    rejectCellState = false,
    fallbackState = 'general',
    extraGeneralCellIds = []
  } = options
  let selector = {
    generation,
    attemptId: 'initial',
    membership: {
      existingOnly: [
        'staging-gce-c1',
        ...(initialState === 'existing-only' ? ['staging-gce-c3'] : [])
      ],
      migrationOnly: [
        ...(fallbackState === 'migration-only' ? ['staging-gce-c2'] : []),
        ...(initialState === 'migration-only' ? ['staging-gce-c3'] : [])
      ],
      general: [
        ...extraGeneralCellIds,
        ...(fallbackState === 'general' ? ['staging-gce-c2'] : []),
        ...(initialState === 'general' ? ['staging-gce-c3'] : [])
      ].sort()
    }
  }
  let intent = null
  let applies = 0
  let drains = 0
  const cellStateChanges = []
  const fetch = async (url, options) => {
    const path = new URL(url).pathname
    const body = JSON.parse(options.body)
    if (path === '/v1/admin/drain') {
      assert.deepEqual(body, { v: 1, graceMs: 0 })
      drains++
      return Response.json({ ok: true })
    }
    if (path === '/v1/admin/cell-status') {
      const state = selector.membership.existingOnly.includes(body.cellId)
        ? 'existing-only'
        : selector.membership.migrationOnly.includes(body.cellId)
          ? 'migration-only'
          : 'general'
      return Response.json({ status: { cellId: body.cellId, admissionState: state } })
    }
    if (path === '/v1/admin/cell-state') {
      assert.equal(selector.generation, 0)
      if (rejectCellState) {
        return Response.json({ error: 'invalid_token' }, { status: 401 })
      }
      const keys = {
        'existing-only': 'existingOnly',
        'migration-only': 'migrationOnly',
        general: 'general'
      }
      for (const cells of Object.values(selector.membership)) {
        const index = cells.indexOf(body.cellId)
        if (index !== -1) cells.splice(index, 1)
      }
      selector.membership[keys[body.state]].push(body.cellId)
      for (const cells of Object.values(selector.membership)) cells.sort()
      cellStateChanges.push({ cellId: body.cellId, state: body.state })
      if (ambiguousCellState) throw new Error('response lost')
      return Response.json({ ok: true })
    }
    if (path.endsWith('/status')) return Response.json({ selector, intent })
    applies++
    selector = {
      generation: body.expectedGeneration + 1,
      attemptId: body.attemptId,
      membership: body.membership
    }
    intent = {
      attemptId: body.attemptId,
      expectedGeneration: body.expectedGeneration,
      intendedGeneration: selector.generation,
      membership: selector.membership,
      state: 'committed'
    }
    return Response.json({ changed: true, selector })
  }
  return {
    fetch,
    selector: () => selector,
    applies: () => applies,
    drains: () => drains,
    cellStateChanges
  }
}

const config = {
  directorOrigin: 'https://relay.example.com',
  cellOrigin: 'https://c3.relay.example.com',
  cellId: 'staging-gce-c3',
  mode: 'isolate',
  restoreGeneralCellIds: []
}

test('isolates a general canary as migration-only', async () => {
  const testHarness = harness('general')
  assert.deepEqual(
    await prepareCapacityCanary(config, { fetch: testHarness.fetch, token: 'masked' }),
    { changed: true, generation: 5, drained: true }
  )
  assert.deepEqual(testHarness.selector().membership.migrationOnly, [config.cellId])
  assert.equal(testHarness.applies(), 1)
  assert.equal(testHarness.drains(), 1)
})

test('activates the canary as the only general cell', async () => {
  const testHarness = harness('migration-only')
  assert.deepEqual(
    await prepareCapacityCanary(
      { ...config, mode: 'activate' },
      { fetch: testHarness.fetch, token: 'masked' }
    ),
    { changed: true, generation: 5 }
  )
  assert.deepEqual(testHarness.selector().membership, {
    existingOnly: ['staging-gce-c1'],
    migrationOnly: ['staging-gce-c2'],
    general: [config.cellId]
  })
  assert.equal(testHarness.applies(), 1)
})

test('restores the reviewed staging general membership', async () => {
  const testHarness = harness('migration-only')
  assert.deepEqual(
    await prepareCapacityCanary(
      {
        ...config,
        mode: 'restore',
        restoreGeneralCellIds: ['staging-gce-c2', config.cellId]
      },
      { fetch: testHarness.fetch, token: 'masked' }
    ),
    { changed: true, generation: 5 }
  )
  assert.deepEqual(testHarness.selector().membership, {
    existingOnly: ['staging-gce-c1'],
    migrationOnly: [],
    general: ['staging-gce-c2', config.cellId]
  })
})

test('restores the fallback without promoting a possibly drained canary', async () => {
  const testHarness = harness('general')
  await prepareCapacityCanary(
    {
      ...config,
      mode: 'restore-fallback',
      restoreGeneralCellIds: ['staging-gce-c2']
    },
    { fetch: testHarness.fetch, token: 'masked' }
  )
  assert.deepEqual(testHarness.selector().membership, {
    existingOnly: ['staging-gce-c1'],
    migrationOnly: [config.cellId],
    general: ['staging-gce-c2']
  })
})

test('restores the fallback while preserving an irreversible canary', async () => {
  const testHarness = harness('existing-only')
  await prepareCapacityCanary(
    {
      ...config,
      mode: 'restore-fallback',
      restoreGeneralCellIds: ['staging-gce-c2']
    },
    { fetch: testHarness.fetch, token: 'masked' }
  )
  assert.deepEqual(testHarness.selector().membership, {
    existingOnly: ['staging-gce-c1', config.cellId],
    migrationOnly: [],
    general: ['staging-gce-c2']
  })
})

test('uses exact legacy admission writes before the selector boundary', async () => {
  const testHarness = harness('general', { generation: 0 })
  assert.deepEqual(
    await prepareCapacityCanary(config, { fetch: testHarness.fetch, token: 'masked' }),
    { changed: true, generation: 0, drained: true }
  )
  assert.deepEqual(testHarness.cellStateChanges, [
    { cellId: config.cellId, state: 'migration-only' }
  ])
  assert.equal(testHarness.drains(), 1)
})

test('promotes a legacy canary before demoting its fallback', async () => {
  const testHarness = harness('migration-only', { generation: 0 })
  await prepareCapacityCanary(
    { ...config, mode: 'activate' },
    { fetch: testHarness.fetch, token: 'masked' }
  )
  assert.deepEqual(testHarness.cellStateChanges, [
    { cellId: config.cellId, state: 'general' },
    { cellId: 'staging-gce-c2', state: 'migration-only' }
  ])
})

test('makes the canary sole general with the live legacy membership shape', async () => {
  const extraGeneralCellIds = ['combined', 'staging-c1', 'staging-c2']
  const testHarness = harness('migration-only', { generation: 0, extraGeneralCellIds })
  const activate = { ...config, mode: 'activate' }
  await prepareCapacityCanary(activate, { fetch: testHarness.fetch, token: 'masked' })
  assert.deepEqual(testHarness.cellStateChanges, [
    { cellId: config.cellId, state: 'general' },
    { cellId: 'combined', state: 'migration-only' },
    { cellId: 'staging-c1', state: 'migration-only' },
    { cellId: 'staging-c2', state: 'migration-only' },
    { cellId: 'staging-gce-c2', state: 'migration-only' }
  ])
})

test('restores a legacy fallback before demoting the target', async () => {
  const testHarness = harness('general', {
    generation: 0,
    fallbackState: 'migration-only'
  })
  await prepareCapacityCanary(
    {
      ...config,
      mode: 'restore-fallback',
      restoreGeneralCellIds: ['staging-gce-c2']
    },
    { fetch: testHarness.fetch, token: 'masked' }
  )
  assert.deepEqual(testHarness.cellStateChanges, [
    { cellId: 'staging-gce-c2', state: 'general' },
    { cellId: config.cellId, state: 'migration-only' }
  ])
})

test('keeps an already restored legacy fallback unchanged', async () => {
  const testHarness = harness('migration-only', { generation: 0 })
  assert.deepEqual(
    await prepareCapacityCanary(
      {
        ...config,
        mode: 'restore-fallback',
        restoreGeneralCellIds: ['staging-gce-c2']
      },
      { fetch: testHarness.fetch, token: 'masked' }
    ),
    { changed: false, generation: 0 }
  )
  assert.deepEqual(testHarness.cellStateChanges, [])
  assert.deepEqual(testHarness.selector().membership, {
    existingOnly: ['staging-gce-c1'],
    migrationOnly: [config.cellId],
    general: ['staging-gce-c2']
  })
})

test('recovers an ambiguous legacy admission response by exact readback', async () => {
  const testHarness = harness('general', { generation: 0, ambiguousCellState: true })
  await assert.doesNotReject(
    prepareCapacityCanary(config, { fetch: testHarness.fetch, token: 'masked' })
  )
  assert.equal(testHarness.drains(), 1)
})

test('reports a rejected legacy admission write without draining', async () => {
  const testHarness = harness('general', { generation: 0, rejectCellState: true })
  const operation = prepareCapacityCanary(config, { fetch: testHarness.fetch, token: 'masked' })
  await assert.rejects(operation, /cell-state returned 401/)
  assert.equal(testHarness.drains(), 0)
})

test('the staging workflow supplies every required capacity transition argument', () => {
  const workflow = readFileSync(
    relayWorkflowUrl('prove-relay-staging-capacity.yml'),
    'utf8'
  )
  const verifyCalls = workflow.match(
    /node dev\/scripts\/verify-relay-capacity-transition\.mjs[\s\S]*?(?=\n\s*\n|\n\s*- name:)/g
  )
  assert.ok(verifyCalls?.length >= 5)
  for (const call of verifyCalls) {
    for (const flag of ['--cell-origin', '--heartbeat', '--admission', '--draining', '--activity']) {
      assert.match(call, new RegExp(flag))
    }
  }
  const isolate = workflow.match(
    /node dev\/scripts\/prepare-relay-capacity-canary\.mjs[\s\S]*?--mode isolate/
  )?.[0]
  assert.match(isolate, /--cell-origin/)
})
