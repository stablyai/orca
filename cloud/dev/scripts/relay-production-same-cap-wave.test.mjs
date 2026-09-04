import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canaryAuthority,
  validateSameCapWave,
  verifyCanaryAuthority
} from './relay-production-same-cap-wave.mjs'

const targetDigest = `sha256:${'a'.repeat(64)}`
const rollbackDigest = `sha256:${'b'.repeat(64)}`

test('requires one canary or a bounded reviewed batch', () => {
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`
  }).cells, ['production-gce-c7'])
  assert.throws(() => validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c7,production-gce-c8',
    targetDigest,
    rollbackDigest,
    confirmation: 'wrong'
  }), /canary/)
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c8,production-gce-c9`,
    canaryRunId: '42'
  }).cells, ['production-gce-c8', 'production-gce-c9'])
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c28',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c28`
  }).cells, ['production-gce-c28'])
  assert.throws(() => validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c30',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c30`
  }), /cells/)
})

test('binds rollback confirmation to the exact digest and ordered cells', () => {
  assert.throws(() => validateSameCapWave({
    mode: 'rollback',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_BACK_RELAY_SAME_CAP ${targetDigest} production-gce-c7`
  }), /confirmation/)
})

test('rollback rolls exactly one cell so later waves stay unreachable', () => {
  const cellIds = 'production-gce-c7,production-gce-c8'
  assert.throws(() => validateSameCapWave({
    mode: 'rollback',
    cellIds,
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} ${cellIds}`
  }), /rollback mode requires exactly one cell/)
  assert.deepEqual(validateSameCapWave({
    mode: 'rollback',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} production-gce-c7`
  }).cells, ['production-gce-c7'])
})

test('seals and verifies canary authority for later batches', () => {
  const authority = canaryAuthority({
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
    commitSha: 'c'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  })
  assert.equal(verifyCanaryAuthority(authority, {
    commitSha: 'c'.repeat(40),
    runId: '42',
    targetDigest,
    rollbackDigest,
    selectorGeneration: '13',
    rehomeGeneration: '4'
  }).cellId, 'production-gce-c7')
  assert.throws(() => verifyCanaryAuthority(authority, {
    commitSha: 'd'.repeat(40),
    runId: '42',
    targetDigest,
    rollbackDigest,
    selectorGeneration: '11',
    rehomeGeneration: '4'
  }), /does not match/)
})
