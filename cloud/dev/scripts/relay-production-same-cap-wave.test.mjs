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
      selectorGeneration: '13',
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
