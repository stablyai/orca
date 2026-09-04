import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  main,
  operateRegionalRehome,
  parseRegionalRehomeArguments,
  recoverRegionalRehomeEnable
} from './operate-relay-regional-rehome.mjs'

const membership = {
  existingOnly: ['production-gce-c1'],
  migrationOnly: ['production-gce-c2'],
  general: ['production-gce-c7', 'production-gce-c27']
}

function argumentsFor(mode, confirmation) {
  return [
    '--mode', mode,
    '--director-origin', 'https://relay.onorca.dev',
    '--expected-selector-generation', '11',
    '--expected-existing-only-cells', membership.existingOnly.join(','),
    '--expected-migration-only-cells', membership.migrationOnly.join(','),
    '--expected-general-cells', membership.general.join(','),
    '--expected-control-generation', '4',
    ...(mode === 'inspect' ? [] : [
      '--not-before', '2000000000000',
      '--rate-per-minute', '10',
      '--preference-max-age-ms', '86400000',
      '--drain-grace-ms', '60000',
      '--confirmation', confirmation
    ])
  ]
}

function control(generation, enabled) {
  return {
    generation,
    enabled,
    observationStartedAt: 1,
    notBefore: 2_000_000_000_000,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    drainGraceMs: 60_000
  }
}

test('parses exact selector and typed control confirmation', () => {
  const parsed = parseRegionalRehomeArguments(
    argumentsFor('enable', 'ENABLE_REGIONAL_REHOMING'),
    { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
  )
  assert.equal(parsed.expectedSelectorGeneration, 11)
  assert.equal(parsed.expectedControlGeneration, 4)
  assert.equal(parsed.ratePerMinute, 10)
  assert.throws(
    () => parseRegionalRehomeArguments(
      argumentsFor('pause', 'DISABLE_REGIONAL_REHOMING'),
      { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
    ),
    /confirmation/
  )
  assert.throws(
    () => parseRegionalRehomeArguments(
      argumentsFor('inspect').concat('--rate-per-minute', '10'),
      { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
    ),
    /inspect cannot/
  )
})

test('binds enable to exact selector and durable control generations', async () => {
  const requests = []
  const controls = [
    { generation: 4, enabled: false },
    { generation: 5, enabled: true },
    { generation: 5, enabled: true }
  ].map((control) => ({
    observationStartedAt: 1,
    notBefore: 0,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    drainGraceMs: 60_000,
    ...control
  }))
  const config = parseRegionalRehomeArguments(
    argumentsFor('enable', 'ENABLE_REGIONAL_REHOMING'),
    { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
  )
  const result = await operateRegionalRehome(config, {
    post: async (path, body) => {
      requests.push({ path, body })
      if (path === '/v1/admin/admission-selector/status') {
        return { selector: { generation: 11, membership } }
      }
      return { v: 1, control: controls.shift() }
    }
  })
  assert.equal(result.control.generation, 5)
  assert.deepEqual(requests[2].body, {
    v: 1,
    action: 'apply',
    expectedGeneration: 4,
    enabled: true,
    notBefore: 2_000_000_000_000,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    drainGraceMs: 60_000,
    confirmation: 'ENABLE_REGIONAL_REHOMING'
  })
})

test('fails closed on selector drift before reading or mutating control', async () => {
  let calls = 0
  const config = parseRegionalRehomeArguments(
    argumentsFor('disable', 'DISABLE_REGIONAL_REHOMING'),
    { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
  )
  await assert.rejects(
    operateRegionalRehome(config, {
      post: async () => {
        calls += 1
        return { selector: { generation: 12, membership } }
      }
    }),
    /selector/
  )
  assert.equal(calls, 1)
})

test('failed-enable recovery CAS-disables an advanced enabled generation', async () => {
  const requests = []
  let current = control(7, true)
  const result = await recoverRegionalRehomeEnable({
    mode: 'recover-enable',
    expectedControlGeneration: 4
  }, async (_path, body) => {
    requests.push(body)
    if (body.action === 'inspect') return { control: current }
    assert.equal(body.expectedGeneration, 7)
    current = control(8, false)
    throw new Error('enable recovery response was lost')
  })
  assert.equal(result.recovered, true)
  assert.deepEqual(result.control, control(8, false))
  assert.deepEqual(requests[1], {
    v: 1,
    action: 'apply',
    expectedGeneration: 7,
    enabled: false,
    notBefore: 2_000_000_000_000,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    drainGraceMs: 60_000,
    confirmation: 'DISABLE_REGIONAL_REHOMING'
  })
})

test('failed-enable recovery retries once when the first CAS never commits', async () => {
  let current = control(7, true)
  const applyRequests = []
  const result = await recoverRegionalRehomeEnable({
    mode: 'recover-enable',
    expectedControlGeneration: 4
  }, async (_path, body) => {
    if (body.action === 'inspect') return { control: current }
    applyRequests.push(body)
    if (applyRequests.length === 1) {
      throw new Error('disable request was lost before commit')
    }
    current = control(8, false)
    throw new Error('retry response was lost after commit')
  })
  assert.equal(applyRequests.length, 2)
  assert.deepEqual(applyRequests[1], applyRequests[0])
  assert.equal(result.recovered, true)
  assert.deepEqual(result.control, control(8, false))
})

test('failed-enable recovery stops after two uncommitted CAS attempts', async () => {
  let applyCalls = 0
  await assert.rejects(
    recoverRegionalRehomeEnable({
      mode: 'recover-enable',
      expectedControlGeneration: 4
    }, async (_path, body) => {
      if (body.action === 'inspect') return { control: control(7, true) }
      applyCalls += 1
      throw new Error(`disable attempt ${applyCalls} was lost before commit`)
    }),
    /exhausted two bounded CAS attempts/
  )
  assert.equal(applyCalls, 2)
})

test('failed-enable recovery is a verified no-op before enable and after cleanup', async () => {
  for (const current of [control(4, false), control(8, false)]) {
    const requests = []
    const result = await recoverRegionalRehomeEnable({
      mode: 'recover-enable',
      expectedControlGeneration: 4
    }, async (_path, body) => {
      requests.push(body)
      return { control: current }
    })
    assert.equal(result.recovered, false)
    assert.equal(result.control.enabled, false)
    assert.deepEqual(requests.map(({ action }) => action), ['inspect', 'inspect'])
  }
})

test('failed-enable recovery rejects an unchanged pre-existing enabled state', async () => {
  await assert.rejects(
    recoverRegionalRehomeEnable({
      mode: 'recover-enable',
      expectedControlGeneration: 4
    }, async () => ({ control: control(4, true) })),
    /cannot belong to the failed enable attempt/
  )
})

test('parses recovery without depending on selector diagnostics', () => {
  const recoveryArguments = [
    '--mode', 'recover-enable',
    '--director-origin', 'https://relay.onorca.dev',
    '--expected-control-generation', '4',
    '--confirmation', 'RECOVER_FAILED_REGIONAL_REHOME_ENABLE'
  ]
  const parsed = parseRegionalRehomeArguments(
    recoveryArguments,
    { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
  )
  assert.equal(parsed.expectedControlGeneration, 4)
  assert.equal(parsed.expectedMembership, undefined)
  assert.throws(
    () => parseRegionalRehomeArguments(
      recoveryArguments.concat('--not-before', '2000000000000'),
      { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }
    ),
    /cannot carry durable control shape/
  )
})

test('main executes recovery mode and emits verified disabled control', async () => {
  let current = control(5, true)
  let output = ''
  await main([
    '--mode', 'recover-enable',
    '--director-origin', 'https://relay.onorca.dev',
    '--expected-control-generation', '4',
    '--confirmation', 'RECOVER_FAILED_REGIONAL_REHOME_ENABLE'
  ], { ORCA_RELAY_ADMIN_ID_TOKEN: 'token' }, {
    post: async (_path, body) => {
      if (body.action === 'apply') current = control(6, false)
      return { control: current }
    }
  }, (value) => {
    output += value
  })
  assert.deepEqual(JSON.parse(output), {
    event: 'relay_regional_rehome_control',
    mode: 'recover-enable',
    recovered: true,
    control: control(6, false)
  })
})
