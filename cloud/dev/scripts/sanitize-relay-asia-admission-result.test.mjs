import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { sanitizeRelayAsiaAdmissionResult } from './sanitize-relay-asia-admission-result.mjs'

const script = fileURLToPath(new URL('./sanitize-relay-asia-admission-result.mjs', import.meta.url))
const expectedKeys = [
  'v', 'mode', 'generation', 'states', 'membership', 'membershipSha256', 'recovered', 'promoted'
]

test('preserves explicit false and emits only the admission evidence allowlist', () => {
  const result = sanitizeRelayAsiaAdmissionResult({
    mode: 'verify', generation: 7, states: { 'staging-gce-c4': 'migration-only' },
    membership: {
      existingOnly: [], migrationOnly: ['staging-gce-c4'], general: [], token: 'nested-secret'
    },
    membershipSha256: 'a'.repeat(64),
    recovered: false, promoted: false,
    token: 'secret', credential: 'secret', userId: 'user', relayHostId: 'host', arbitrary: true
  })

  assert.deepEqual(Object.keys(result), expectedKeys)
  assert.equal(result.recovered, false)
  assert.equal(result.promoted, false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(Object.keys(result.membership), ['existingOnly', 'migrationOnly', 'general'])
  assert.equal('token' in result, false)
  assert.equal('credential' in result, false)
  assert.equal('userId' in result, false)
  assert.equal('relayHostId' in result, false)
  assert.equal('arbitrary' in result, false)
})

test('uses null for missing optional admission evidence', () => {
  assert.deepEqual(sanitizeRelayAsiaAdmissionResult({
    mode: 'verify', generation: 0, states: { 'staging-gce-c4': 'absent' }
  }), {
    v: 1,
    mode: 'verify',
    generation: 0,
    states: { 'staging-gce-c4': 'absent' },
    membership: null,
    membershipSha256: null,
    recovered: null,
    promoted: null
  })
})

test('preserves valid historical cell IDs accepted by the director schema', () => {
  const legacyCellId = 'legacy staging cell'
  const result = sanitizeRelayAsiaAdmissionResult({
    mode: 'inspect',
    generation: 0,
    states: { [legacyCellId]: 'general' },
    membership: { existingOnly: [], migrationOnly: [], general: [legacyCellId] },
    membershipSha256: 'a'.repeat(64)
  })

  assert.deepEqual(result.states, { [legacyCellId]: 'general' })
  assert.deepEqual(result.membership.general, [legacyCellId])
})

test('sanitizes stdin through the command-line entry point', () => {
  const run = spawnSync(process.execPath, [script], {
    input: JSON.stringify({
      mode: 'verify', generation: 0, states: { 'staging-gce-c4': 'absent' },
      recovered: false, token: 'secret'
    }),
    encoding: 'utf8'
  })

  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.deepEqual(Object.keys(result), expectedKeys)
  assert.equal(result.recovered, false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('requires the evidence needed by every sequenced operation mode', () => {
  const states = { 'staging-gce-c4': 'migration-only' }
  const membership = {
    existingOnly: [], migrationOnly: ['staging-gce-c4'], general: []
  }
  const validByMode = {
    inspect: { membership, membershipSha256: 'a'.repeat(64) },
    initialize: {},
    verify: {},
    registered: {},
    register: {},
    promote: {},
    'recover-promotion': { promoted: false },
    rollback: {}
  }

  for (const [mode, evidence] of Object.entries(validByMode)) {
    assert.doesNotThrow(() => sanitizeRelayAsiaAdmissionResult({
      mode, generation: 1, states, ...evidence
    }))
    assert.throws(() => sanitizeRelayAsiaAdmissionResult({ mode, generation: 1, ...evidence }))
  }
  assert.throws(() => sanitizeRelayAsiaAdmissionResult({
    mode: 'inspect', generation: 1, states, membership
  }))
  assert.throws(() => sanitizeRelayAsiaAdmissionResult({
    mode: 'inspect', generation: 1, states, membershipSha256: 'a'.repeat(64)
  }))
  assert.throws(() => sanitizeRelayAsiaAdmissionResult({
    mode: 'recover-promotion', generation: 1, states
  }))
})

test('rejects invalid stdin without echoing it', () => {
  const run = spawnSync(process.execPath, [script], { input: '{secret', encoding: 'utf8' })

  assert.equal(run.status, 1)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr, 'invalid Relay Asia admission result\n')
  assert.equal(run.stderr.includes('{secret'), false)
})
