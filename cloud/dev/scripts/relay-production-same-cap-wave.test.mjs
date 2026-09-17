import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('reuses a canary across selector advances only within the same control epoch', () => {
  const authority = canaryAuthority({
    cellIds: 'production-gce-c7', targetDigest, rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
    commitSha: 'c'.repeat(40), runId: '42', selectorGeneration: '11', rehomeGeneration: '4'
  })
  const expected = {
    commitSha: 'c'.repeat(40), runId: '42', targetDigest, rollbackDigest,
    selectorGeneration: '21', rehomeGeneration: '4'
  }
  for (const generation of ['13', '14', '21', '29']) {
    assert.equal(verifyCanaryAuthority(authority, {
      ...expected, selectorGeneration: generation
    }), authority)
  }
  for (const generation of ['12', '-1', 'NaN', 'Infinity', '13.5', '9007199254740992']) {
    assert.throws(() => verifyCanaryAuthority(authority, {
      ...expected, selectorGeneration: generation
    }), /does not match/)
  }
  for (const generation of [-1, NaN, Infinity, 13.5, '13', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => verifyCanaryAuthority({
      ...authority, selectorGeneration: generation
    }, expected), /does not match/)
  }
  for (const mismatch of [
    { rehomeGeneration: '3' }, { rehomeGeneration: '5' },
    { targetDigest: rollbackDigest }, { rollbackDigest: targetDigest }, { runId: '43' }
  ]) {
    assert.throws(() => verifyCanaryAuthority(authority, {
      ...expected, ...mismatch
    }), /does not match/)
  }
})

function gitIn(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function canaryRepository() {
  const root = await mkdtemp(join(tmpdir(), 'relay-same-cap-canary-'))
  gitIn(root, 'init', '--quiet')
  gitIn(root, 'config', 'user.email', 'relay@example.test')
  gitIn(root, 'config', 'user.name', 'Relay Wave Test')
  gitIn(root, 'config', 'commit.gpgsign', 'false')
  const commit = async (path, body, message) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
    gitIn(root, 'add', '--all')
    gitIn(root, 'commit', '--quiet', '--no-verify', '--message', message)
    return gitIn(root, 'rev-parse', 'HEAD')
  }
  const sealed = await commit(
    'cloud/dev/scripts/relay-production-same-cap-wave.mjs',
    'export const v = 1\n',
    'wave'
  )
  const sameCode = await commit('README.md', 'an unrelated merge\n', 'unrelated')
  const changedCode = await commit(
    'cloud/dev/scripts/relay-production-same-cap-wave.mjs',
    'export const v = 2\n',
    'wave change'
  )
  return { root, sealed, sameCode, changedCode }
}

test('a batch trusts a canary sealed by identical code at an ancestor commit', async () => {
  const repository = await canaryRepository()
  try {
    const authority = canaryAuthority({
      cellIds: 'production-gce-c7',
      targetDigest,
      rollbackDigest,
      confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
      commitSha: repository.sealed,
      runId: '42',
      selectorGeneration: '11',
      rehomeGeneration: '4'
    })
    const verifyAt = (commitSha, repositoryRoot) => verifyCanaryAuthority(authority, {
      commitSha,
      runId: '42',
      targetDigest,
      rollbackDigest,
      selectorGeneration: '21',
      rehomeGeneration: '4'
    }, repositoryRoot)
    assert.equal(verifyAt(repository.sameCode, repository.root).cellId, 'production-gce-c7')
    assert.throws(
      () => verifyAt(repository.changedCode, repository.root),
      /code changed after it was sealed/
    )
    assert.throws(() => verifyAt('f'.repeat(40), repository.root), /unknown to this checkout/)
  } finally {
    await rm(repository.root, { recursive: true, force: true })
  }
})

// Why: the break-glass override is the one input that removes a safety check, so
// a partial or mismatched one must fail before the gate job reaches a mutation.
test('accepts only a complete digest-bound monitor gate override', () => {
  const reason = 'rolling the measured Cloud SQL stall fix'
  const confirmation = `SKIP_RELAY_MONITOR_GATE ${targetDigest}`
  const wave = {
    mode: 'canary-apply',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`
  }
  assert.deepEqual(
    validateSameCapWave({
      ...wave,
      gateOverrideReason: reason,
      gateOverrideConfirmation: confirmation
    }).gateOverride,
    { reason, confirmation }
  )
  // An ordinary wave carries no override at all.
  assert.equal(validateSameCapWave(wave).gateOverride, null)
  assert.equal(
    validateSameCapWave({ ...wave, gateOverrideReason: '', gateOverrideConfirmation: '' })
      .gateOverride,
    null
  )
  assert.throws(
    () => validateSameCapWave({ ...wave, gateOverrideConfirmation: confirmation }),
    /gate override reason/
  )
  assert.throws(
    () => validateSameCapWave({ ...wave, gateOverrideReason: reason }),
    /gate override confirmation/
  )
  // Bound to the digest this wave installs, not to any digest.
  assert.throws(
    () => validateSameCapWave({
      ...wave,
      gateOverrideReason: reason,
      gateOverrideConfirmation: `SKIP_RELAY_MONITOR_GATE ${rollbackDigest}`
    }),
    /gate override confirmation/
  )
  assert.throws(
    () => validateSameCapWave({
      ...wave,
      gateOverrideReason: 'too short',
      gateOverrideConfirmation: confirmation
    }),
    /gate override reason/
  )
  // The reason is rendered into the run summary, so it stays printable and single-line.
  assert.throws(
    () => validateSameCapWave({
      ...wave,
      gateOverrideReason: `${reason}\n| injected | row |`,
      gateOverrideConfirmation: confirmation
    }),
    /gate override reason/
  )
  assert.throws(
    () => validateSameCapWave({
      ...wave,
      mode: 'verify',
      confirmation: '',
      gateOverrideReason: reason,
      gateOverrideConfirmation: confirmation
    }),
    /verify does not accept a monitor gate override/
  )
})

test('a rollback wave may break the glass on its own target digest', () => {
  const reason = 'getting off the bad image during an incident'
  assert.deepEqual(
    validateSameCapWave({
      mode: 'rollback',
      cellIds: 'production-gce-c7',
      targetDigest,
      rollbackDigest,
      confirmation: `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} production-gce-c7`,
      gateOverrideReason: reason,
      gateOverrideConfirmation: `SKIP_RELAY_MONITOR_GATE ${targetDigest}`
    }).gateOverride,
    { reason, confirmation: `SKIP_RELAY_MONITOR_GATE ${targetDigest}` }
  )
})

// Why: the canary authority never carried a monitor run ID, so a batch can reuse
// a canary rolled under an override. Recording it keeps the audit trail in the
// sealed artifact without making it part of what verification demands.
test('seals the override into the canary authority as audit trail only', () => {
  const sealed = {
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
    commitSha: 'f'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  }
  const expected = {
    commitSha: 'f'.repeat(40),
    runId: '42',
    targetDigest,
    rollbackDigest,
    selectorGeneration: '21',
    rehomeGeneration: '4'
  }
  const overridden = canaryAuthority({
    ...sealed,
    gateOverrideReason: 'rolling the measured Cloud SQL stall fix',
    gateOverrideConfirmation: `SKIP_RELAY_MONITOR_GATE ${targetDigest}`,
    actor: 'Jinwoo-H'
  })
  assert.deepEqual(overridden.gateOverride, {
    reason: 'rolling the measured Cloud SQL stall fix',
    confirmation: `SKIP_RELAY_MONITOR_GATE ${targetDigest}`,
    actor: 'Jinwoo-H'
  })
  assert.equal(canaryAuthority(sealed).gateOverride, null)
  // Neither shape changes what a batch verifies.
  assert.equal(verifyCanaryAuthority(overridden, expected).cellId, 'production-gce-c7')
  assert.equal(
    verifyCanaryAuthority(canaryAuthority(sealed), expected).cellId,
    'production-gce-c7'
  )
})
