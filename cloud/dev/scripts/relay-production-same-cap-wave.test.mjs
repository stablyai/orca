import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  CANARY_MIN_DRAINED_HOSTS,
  DEFAULT_SAME_CAP_DRAIN_PACE_WINDOW_MS,
  SAME_CAP_CELLS,
  SAME_CAP_DRAIN_PACE_WINDOWS_MS,
  SAME_CAP_FAST_DRAIN_PACE_CELLS,
  SAME_CAP_MIGRATION_ONLY_CELLS,
  canaryAuthority,
  entryAdmission,
  main,
  selectorWaveDelta,
  validateSameCapWave,
  verifyCanaryAuthority
} from './relay-production-same-cap-wave.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'

const targetDigest = `sha256:${'a'.repeat(64)}`
const rollbackDigest = `sha256:${'b'.repeat(64)}`

test('requires one canary or a bounded reviewed batch', () => {
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`
  }).cells, ['production-gce-c7'])
  assert.throws(() => validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c7,production-gce-c8',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: 'wrong'
  }), /canary/)
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c8,production-gce-c9`,
    canaryRunId: '42'
  }).cells, ['production-gce-c8', 'production-gce-c9'])
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c28',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c28`
  }).cells, ['production-gce-c28'])
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c30',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c30`
  }).cells, ['production-gce-c30'])
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c31',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c31`
  }).cells, ['production-gce-c31'])
  for (const cellId of ['production-gce-c32', 'production-gce-c33', 'production-gce-c34']) {
    assert.deepEqual(validateSameCapWave({
      mode: 'canary-apply',
      cellIds: cellId,
      targetDigest,
      rollbackDigest,
      drainPaceWindowMs: '300000',
      confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellId}`
    }).cells, [cellId])
  }
  assert.throws(() => validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c35',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c35`
  }), /cells/)
})

// The bound is the wave workflow's static cell_1..cell_10 chain: a batch longer than the
// chain would silently drop its tail cells, so it is refused before any mutation.
test('a batch fills the serial cell chain and never overflows it', () => {
  const general = SAME_CAP_CELLS.filter((cell) => entryAdmission(cell) === 'general')
  const batch = (count) => {
    const cellIds = general.slice(0, count).join(',')
    return validateSameCapWave({
      mode: 'batch-apply',
      cellIds,
      targetDigest,
      rollbackDigest,
      drainPaceWindowMs: '300000',
      confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellIds}`,
      canaryRunId: '42'
    })
  }
  assert.equal(batch(10).cells.length, 10)
  assert.throws(() => batch(11), /same-cap wave cells are invalid/)
  assert.throws(() => batch(1), /batch mode requires two to ten cells/)
})

// The validator's ten-cell bound is only true if the workflow really declares ten strictly
// serial cell jobs and frees the lease after all of them.
test('the wave workflow chains exactly ten serial cell jobs', () => {
  const dispatch = readRelayWorkflow('deploy-relay-production-same-cap.yml')
  for (let index = 0; index < 10; index += 1) {
    const job = index + 1
    assert.match(dispatch, new RegExp(`\n  cell_${job}:\n`), `cell_${job} is missing`)
    assert.match(dispatch, new RegExp(`fromJSON\\(needs\\.gate\\.outputs\\.cells\\)\\[${index}\\]`))
    assert.match(dispatch, new RegExp(`wave-index: '${index}'`))
    if (index > 0) {
      assert.match(dispatch, new RegExp(`needs: \\[gate, cell_${index}\\]`))
      assert.match(
        dispatch,
        new RegExp(`if: \\$\\{\\{ needs\\.cell_${index}\\.result == 'success' && ` +
          `fromJSON\\(needs\\.gate\\.outputs\\.cells\\)\\[${index}\\] != null \\}\\}`)
      )
    }
    assert.match(dispatch, new RegExp(`\n      - cell_${job}\n`), `release_lease must need cell_${job}`)
  }
  assert.doesNotMatch(dispatch, /\n  cell_11:/)
})

test('lists only C17 and C18 as migration-only now that C34 is promoted, and C30-C34 as general', () => {
  assert.deepEqual(SAME_CAP_MIGRATION_ONLY_CELLS, ['production-gce-c17', 'production-gce-c18'])
  for (const cellId of [
    'production-gce-c30', 'production-gce-c31', 'production-gce-c32', 'production-gce-c33',
    'production-gce-c34'
  ]) {
    assert.equal(SAME_CAP_CELLS.includes(cellId), true, cellId)
  }
})

test('rolls the migration-only cells but never mixes the two classes in one wave', () => {
  for (const cellId of SAME_CAP_MIGRATION_ONLY_CELLS) {
    assert.equal(SAME_CAP_CELLS.includes(cellId), true, cellId)
    assert.equal(entryAdmission(cellId), 'migration-only', cellId)
    assert.deepEqual(validateSameCapWave({
      mode: 'canary-apply',
      cellIds: cellId,
      targetDigest,
      rollbackDigest,
      drainPaceWindowMs: '300000',
      confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellId}`
    }).cells, [cellId])
  }
  const cellIds = 'production-gce-c17,production-gce-c18'
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellIds}`,
    canaryRunId: '42'
  }).cells, ['production-gce-c17', 'production-gce-c18'])
  // C30 is general since its 2026-09-23 promotion, so it cannot share a wave with C17/C18.
  assert.equal(entryAdmission('production-gce-c30'), 'general')
  assert.equal(selectorWaveDelta('production-gce-c30'), 2)
  const asiaGeneral = 'production-gce-c29,production-gce-c30'
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds: asiaGeneral,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${asiaGeneral}`,
    canaryRunId: '42'
  }).cells, ['production-gce-c29', 'production-gce-c30'])
  const asiaMixed = 'production-gce-c30,production-gce-c17'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: asiaMixed,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${asiaMixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
  // C31 is general since its 2026-10-01 promotion, so it rolls beside C30 but never C17/C18.
  assert.equal(entryAdmission('production-gce-c31'), 'general')
  assert.equal(selectorWaveDelta('production-gce-c31'), 2)
  const asiaPromoted = 'production-gce-c30,production-gce-c31'
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds: asiaPromoted,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${asiaPromoted}`,
    canaryRunId: '42'
  }).cells, ['production-gce-c30', 'production-gce-c31'])
  // C34 is general once its Asia canary promotes it, so a rollback restores it general.
  assert.equal(entryAdmission('production-gce-c34'), 'general')
  assert.equal(selectorWaveDelta('production-gce-c34'), 2)
  const c34Mixed = 'production-gce-c34,production-gce-c17'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: c34Mixed,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${c34Mixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
  const c31Mixed = 'production-gce-c31,production-gce-c18'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: c31Mixed,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${c31Mixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
  // C32 and C33 are general since their 2026-10-01 promotions: they roll beside US 1k cells,
  // isolate and restore (delta 2), and never share a wave with C17/C18.
  for (const cellId of ['production-gce-c32', 'production-gce-c33']) {
    assert.equal(entryAdmission(cellId), 'general', cellId)
    assert.equal(selectorWaveDelta(cellId), 2, cellId)
  }
  const usPromoted = 'production-gce-c26,production-gce-c32,production-gce-c33'
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds: usPromoted,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usPromoted}`,
    canaryRunId: '42'
  }).cells, ['production-gce-c26', 'production-gce-c32', 'production-gce-c33'])
  const usMixed = 'production-gce-c32,production-gce-c17'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: usMixed,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usMixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
  // A mixed wave has no single selector delta for its later cells to offset from.
  const mixed = 'production-gce-c7,production-gce-c17'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: mixed,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${mixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
})

test('seals a migration-only canary at the generation its wave leaves behind', () => {
  const seal = (cellId) => canaryAuthority({
    cellIds: cellId,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellId}`,
    commitSha: 'c'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  })
  // Isolate and restore are both no-ops on a migration-only cell, so nothing advances.
  assert.equal(seal('production-gce-c17').selectorGeneration, 11)
  assert.equal(seal('production-gce-c7').selectorGeneration, 13)
  // That canary still authorizes a later batch of its own class; it is evidence about the image.
  assert.equal(verifyCanaryAuthority(seal('production-gce-c17'), {
    commitSha: 'c'.repeat(40),
    runId: '42',
    cellIds: 'production-gce-c17,production-gce-c18',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  }).cellId, 'production-gce-c17')
})

test('reports each approved cell\'s class and selector delta', () => {
  const printed = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => printed.push(String(chunk))
  try {
    main(['cell-class', '--cell-id', 'production-gce-c17', '--drain-pace-window-ms', '300000'])
    main(['cell-class', '--cell-id', 'production-gce-c7', '--drain-pace-window-ms', '60000'])
  } finally {
    process.stdout.write = write
  }
  assert.deepEqual(printed.map((line) => JSON.parse(line)), [
    { entryAdmission: 'migration-only', selectorWaveDelta: 0, drainPaceWindowMs: 300000 },
    { entryAdmission: 'general', selectorWaveDelta: 2, drainPaceWindowMs: 60000 }
  ])
  assert.throws(() => main([
    'cell-class', '--cell-id', 'production-gce-c12', '--drain-pace-window-ms', '300000'
  ]), /cells are invalid/)
  // The job re-checks the pace per cell, so a cell outside the fast list cannot drain fast.
  assert.throws(() => main([
    'cell-class', '--cell-id', 'production-gce-c28', '--drain-pace-window-ms', '30000'
  ]), /US general cells only, not production-gce-c28/)
  assert.throws(() => main(['cell-class', '--cell-id', 'production-gce-c7']), /drain pace window/)
})

test('binds rollback confirmation to the exact digest and ordered cells', () => {
  assert.throws(() => validateSameCapWave({
    mode: 'rollback',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
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
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} ${cellIds}`
  }), /rollback mode requires exactly one cell/)
  assert.deepEqual(validateSameCapWave({
    mode: 'rollback',
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} production-gce-c7`
  }).cells, ['production-gce-c7'])
})

test('seals and verifies canary authority for later batches', () => {
  const authority = canaryAuthority({
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
    commitSha: 'c'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  })
  assert.equal(verifyCanaryAuthority(authority, {
    commitSha: 'c'.repeat(40),
    runId: '42',
    cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    selectorGeneration: '13',
    rehomeGeneration: '4'
  }).cellId, 'production-gce-c7')
  assert.throws(() => verifyCanaryAuthority(authority, {
    commitSha: 'd'.repeat(40),
    runId: '42',
    cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  }), /does not match/)
})

test('reuses a canary across selector advances only within the same control epoch', () => {
  const authority = canaryAuthority({
    cellIds: 'production-gce-c7', targetDigest, rollbackDigest, drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
    commitSha: 'c'.repeat(40), runId: '42', selectorGeneration: '11', rehomeGeneration: '4'
  })
  const expected = {
    commitSha: 'c'.repeat(40), runId: '42', cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest, rollbackDigest, drainPaceWindowMs: '300000', selectorGeneration: '21', rehomeGeneration: '4'
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
      drainPaceWindowMs: '300000',
      confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7`,
      commitSha: repository.sealed,
      runId: '42',
      selectorGeneration: '11',
      rehomeGeneration: '4'
    })
    const verifyAt = (commitSha, repositoryRoot) => verifyCanaryAuthority(authority, {
      commitSha,
      runId: '42',
      cellIds: 'production-gce-c8,production-gce-c9',
      targetDigest,
      rollbackDigest,
      drainPaceWindowMs: '300000',
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


function sealedCanary(cellId) {
  return canaryAuthority({
    cellIds: cellId,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellId}`,
    commitSha: 'c'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  })
}

// Why: a migration-only cell holds zero hosts at a different cap and its wave advances no
// selector, so rolling one is no evidence for a general batch, and the reverse is no evidence
// either. Nothing but the sealed cell id says which class a canary actually proved.
test('refuses a canary sealed on a cell of the other admission class', () => {
  const expected = {
    commitSha: 'c'.repeat(40),
    runId: '42',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '300000',
    selectorGeneration: '99',
    rehomeGeneration: '4'
  }
  const general = 'production-gce-c8,production-gce-c9'
  const migrationOnly = SAME_CAP_MIGRATION_ONLY_CELLS.join(',')
  assert.throws(
    () => verifyCanaryAuthority(sealedCanary('production-gce-c17'), {
      ...expected, cellIds: general
    }),
    /canary authority cell production-gce-c17 is migration-only, but this batch is general/
  )
  assert.throws(
    () => verifyCanaryAuthority(sealedCanary('production-gce-c7'), {
      ...expected, cellIds: migrationOnly
    }),
    /canary authority cell production-gce-c7 is general, but this batch is migration-only/
  )
  assert.equal(
    verifyCanaryAuthority(sealedCanary('production-gce-c7'), {
      ...expected, cellIds: general
    }).cellId,
    'production-gce-c7'
  )
  assert.equal(
    verifyCanaryAuthority(sealedCanary('production-gce-c17'), {
      ...expected, cellIds: migrationOnly
    }).cellId,
    'production-gce-c17'
  )
  // A caller that names no batch at all gets no verdict, rather than an unchecked class.
  assert.throws(
    () => verifyCanaryAuthority(sealedCanary('production-gce-c7'), expected),
    /same-cap wave cells are invalid/
  )
})

// The dispatch workflow is the only caller, so the class check only binds anything if that
// step actually hands the batch over; run the step's own shell exactly as written.
function verifyCanaryStepScript() {
  const dispatch = readRelayWorkflow('deploy-relay-production-same-cap.yml')
  const first = '          node dev/scripts/relay-production-same-cap-wave.mjs verify-canary \\\n'
  const start = dispatch.indexOf(first)
  assert.notEqual(start, -1, 'the dispatch workflow has no verify-canary step')
  const last = '            --rehome-generation "${REHOME_GENERATION}"\n'
  const end = dispatch.indexOf(last, start)
  assert.notEqual(end, -1, 'the verify-canary step does not end at the rehome generation')
  return dispatch.slice(start, end + last.length).replace(/^ {10}/gm, '')
}

async function runVerifyCanaryStep(authority, cellIds, drainPaceWindowMs = '300000') {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-same-cap-verify-'))
  try {
    await mkdir(join(temporary, 'relay-same-cap-canary'), { recursive: true })
    await writeFile(
      join(temporary, 'relay-same-cap-canary', 'authority.json'),
      JSON.stringify(authority)
    )
    return spawnSync('bash', ['-euo', 'pipefail', '-c', verifyCanaryStepScript()], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        RUNNER_TEMP: temporary,
        GITHUB_SHA: authority.commitSha,
        CANARY_RUN_ID: authority.runId,
        CELL_IDS: cellIds,
        TARGET_DIGEST: targetDigest,
        ROLLBACK_DIGEST: rollbackDigest,
        SELECTOR_GENERATION: '99',
        REHOME_GENERATION: '4',
        DRAIN_PACE_WINDOW_MS: drainPaceWindowMs
      },
      encoding: 'utf8'
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

test('the batch gate hands its own cells to the canary check', async () => {
  const accepted = await runVerifyCanaryStep(
    sealedCanary('production-gce-c7'),
    'production-gce-c8,production-gce-c9'
  )
  assert.equal(accepted.status, 0, accepted.stderr)
  const crossed = await runVerifyCanaryStep(
    sealedCanary('production-gce-c17'),
    'production-gce-c8,production-gce-c9'
  )
  assert.equal(crossed.status, 1, crossed.stdout)
  assert.match(
    crossed.stderr,
    /canary authority cell production-gce-c17 is migration-only, but this batch is general/
  )
  const migrationOnly = await runVerifyCanaryStep(
    sealedCanary('production-gce-c17'),
    SAME_CAP_MIGRATION_ONLY_CELLS.join(',')
  )
  assert.equal(migrationOnly.status, 0, migrationOnly.stderr)
  // The batch's own pace reaches the check, so a 300 s canary cannot authorize a faster batch.
  const faster = await runVerifyCanaryStep(
    sealedCanary('production-gce-c7'),
    'production-gce-c8,production-gce-c9',
    '60000'
  )
  assert.equal(faster.status, 1, faster.stdout)
  assert.match(faster.stderr, /drained over 300000 ms, so it cannot authorize a batch draining over 60000 ms/)
})

const usGeneral = 'production-gce-c8,production-gce-c32'

function fastWave(overrides = {}) {
  return {
    mode: 'batch-apply',
    cellIds: usGeneral,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '60000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usGeneral} drain-pace-window-ms=60000`,
    canaryRunId: '42',
    ...overrides
  }
}

test('admits only the reviewed drain pace windows', () => {
  assert.deepEqual(SAME_CAP_DRAIN_PACE_WINDOWS_MS, [300_000, 60_000, 30_000])
  assert.equal(validateSameCapWave(fastWave()).drainPaceWindowMs, 60_000)
  assert.equal(validateSameCapWave(fastWave({
    drainPaceWindowMs: '30000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usGeneral} drain-pace-window-ms=30000`
  })).drainPaceWindowMs, 30_000)
  for (const pace of [undefined, '', '0', '120000', '299999', '600000', '60000.0', '060000', ' 60000']) {
    assert.throws(
      () => validateSameCapWave(fastWave({ drainPaceWindowMs: pace })),
      /drain pace window must be one of 300000, 60000, 30000 ms/,
      String(pace)
    )
  }
  // Verify reads production, never drains, but still states the pace it would roll at.
  assert.equal(validateSameCapWave(fastWave({
    mode: 'verify', confirmation: '', canaryRunId: ''
  })).drainPaceWindowMs, 60_000)
})

test('keeps Asia and migration-only cells on the default pace', () => {
  assert.deepEqual(
    SAME_CAP_FAST_DRAIN_PACE_CELLS.filter((cell) => !SAME_CAP_CELLS.includes(cell)),
    []
  )
  for (const cellId of SAME_CAP_CELLS) {
    const fast = SAME_CAP_FAST_DRAIN_PACE_CELLS.includes(cellId)
    const asia = ['c27', 'c28', 'c29', 'c30', 'c31', 'c34'].some(
      (cell) => cellId === `production-gce-${cell}`
    )
    assert.equal(fast, entryAdmission(cellId) === 'general' && !asia, cellId)
  }
  const asia = 'production-gce-c30,production-gce-c31'
  assert.throws(() => validateSameCapWave(fastWave({
    cellIds: asia,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${asia} drain-pace-window-ms=60000`
  })), /US general cells only, not production-gce-c30,production-gce-c31/)
  // One Asia cell in an otherwise US batch is enough to refuse the whole batch.
  const mixed = 'production-gce-c8,production-gce-c29'
  assert.throws(() => validateSameCapWave(fastWave({
    cellIds: mixed,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${mixed} drain-pace-window-ms=60000`
  })), /not production-gce-c29$/)
  assert.throws(() => validateSameCapWave(fastWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c17',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c17 drain-pace-window-ms=60000`,
    canaryRunId: ''
  })), /not production-gce-c17/)
})

test('binds a non-default pace into the confirmation, in both directions', () => {
  // A confirmation that does not name the pace is a confirmation of the default.
  assert.throws(() => validateSameCapWave(fastWave({
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usGeneral}`
  })), /confirmation does not match/)
  assert.throws(() => validateSameCapWave(fastWave({
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usGeneral} drain-pace-window-ms=30000`
  })), /confirmation does not match/)
  assert.throws(() => validateSameCapWave(fastWave({
    drainPaceWindowMs: '300000'
  })), /confirmation does not match/)
  assert.throws(() => validateSameCapWave(fastWave({
    drainPaceWindowMs: '300000',
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${usGeneral} drain-pace-window-ms=300000`
  })), /confirmation does not match/)
  assert.deepEqual(validateSameCapWave(fastWave({
    mode: 'rollback',
    cellIds: 'production-gce-c8',
    confirmation: `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} production-gce-c8 drain-pace-window-ms=60000`,
    canaryRunId: ''
  })).cells, ['production-gce-c8'])
})

function shadowReport(pace, paceVerdict = 'PASS', overrides = {}) {
  return {
    cellId: 'production-gce-c7',
    paceVerdict,
    drain: { paceWindowMs: Number(pace), appliedPaceWindowMs: Number(pace), targetHosts: 692 },
    ...overrides
  }
}

test('a canary authorizes batches at its own pace or slower, never faster', () => {
  const seal = (pace, report = shadowReport(pace)) => canaryAuthority({
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: pace,
    shadowReport: report,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7` +
      (pace === '300000' ? '' : ` drain-pace-window-ms=${pace}`),
    commitSha: 'c'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  })
  assert.equal(seal('60000').v, 2)
  assert.equal(seal('60000').drainPaceWindowMs, 60_000)
  const verify = (authority, pace) => verifyCanaryAuthority(authority, {
    commitSha: 'c'.repeat(40),
    runId: '42',
    cellIds: usGeneral,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: pace,
    selectorGeneration: '13',
    rehomeGeneration: '4'
  })
  // Stepping back to the default after a bad rung needs no new canary.
  for (const pace of ['60000', '300000']) assert.equal(verify(seal('60000'), pace).cellId, 'production-gce-c7')
  assert.throws(() => verify(seal('60000'), '30000'), /drained over 60000 ms/)
  assert.throws(() => verify(seal('300000'), '60000'), /drained over 300000 ms/)
  // An authority sealed before the pace was recorded proves nothing about it.
  const { drainPaceWindowMs: _dropped, ...unpaced } = seal('300000')
  assert.throws(() => verify({ ...unpaced, v: 1 }, '300000'), /does not match/)
  assert.throws(() => verify({ ...seal('300000'), drainPaceWindowMs: 0 }, '300000'), /does not match/)
  assert.throws(() => verify({ ...seal('300000'), paceVerdict: 'pass' }, '300000'), /does not match/)
})

// A canary whose own drain looked bad still succeeds as a job, so the seal must carry what its pace
// checks said, and a faster batch must refuse anything but PASS.
test('only a canary whose pace checks passed authorizes a faster batch', () => {
  const seal = (report) => canaryAuthority({
    cellIds: 'production-gce-c7',
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: '60000',
    shadowReport: report,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7 drain-pace-window-ms=60000`,
    commitSha: 'c'.repeat(40),
    runId: '42',
    selectorGeneration: '11',
    rehomeGeneration: '4'
  })
  const verify = (authority, pace) => verifyCanaryAuthority(authority, {
    commitSha: 'c'.repeat(40),
    runId: '42',
    cellIds: usGeneral,
    targetDigest,
    rollbackDigest,
    drainPaceWindowMs: pace,
    selectorGeneration: '13',
    rehomeGeneration: '4'
  })
  assert.equal(seal(shadowReport('60000')).paceVerdict, 'PASS')
  assert.equal(CANARY_MIN_DRAINED_HOSTS, 400)
  assert.equal(seal(shadowReport('60000', 'PASS', {
    drain: { paceWindowMs: 60000, appliedPaceWindowMs: 60000, targetHosts: 400 }
  })).paceVerdict, 'PASS')
  for (const [report, sealed] of [
    [shadowReport('60000', 'WARN'), 'WARN'],
    [shadowReport('60000', 'WOULD_BLOCK'), 'WOULD_BLOCK'],
    [null, 'UNVERIFIED'],
    // Another cell's report, another pace's, or a cell that fell back to an unpaced drain.
    [shadowReport('60000', 'PASS', { cellId: 'production-gce-c8' }), 'UNVERIFIED'],
    [shadowReport('300000'), 'UNVERIFIED'],
    [shadowReport('60000', 'PASS', { drain: { paceWindowMs: 60000, appliedPaceWindowMs: 0, targetHosts: 692 } }), 'UNVERIFIED'],
    // Too few hosts to have tested the pace, or no host count at all.
    [shadowReport('60000', 'PASS', { drain: { paceWindowMs: 60000, appliedPaceWindowMs: 60000, targetHosts: 399 } }), 'UNVERIFIED'],
    [shadowReport('60000', 'PASS', { drain: { paceWindowMs: 60000, appliedPaceWindowMs: 60000, targetHosts: 0 } }), 'UNVERIFIED'],
    [shadowReport('60000', 'PASS', { drain: { paceWindowMs: 60000, appliedPaceWindowMs: 60000, targetHosts: null } }), 'UNVERIFIED'],
    [shadowReport('60000', 'MAYBE'), 'UNVERIFIED']
  ]) {
    const authority = seal(report)
    assert.equal(authority.paceVerdict, sealed)
    assert.throws(() => verify(authority, '60000'), new RegExp(`pace checks were ${sealed}`))
    // Falling back to the default never needs a passing canary.
    assert.equal(verify(authority, '300000').cellId, 'production-gce-c7')
  }
})

test('create-canary seals the verdict from the canary cell\'s shadow report file', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'relay-same-cap-seal-'))
  const printed = []
  const write = process.stdout.write.bind(process.stdout)
  try {
    const path = join(temporary, 'report.json')
    await writeFile(path, JSON.stringify(shadowReport('60000')))
    process.stdout.write = (chunk) => printed.push(String(chunk))
    for (const report of [path, join(temporary, 'missing.json')]) {
      main([
        'create-canary', '--cell-id', 'production-gce-c7',
        '--target-digest', targetDigest, '--rollback-digest', rollbackDigest,
        '--confirmation', `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c7 drain-pace-window-ms=60000`,
        '--drain-pace-window-ms', '60000', '--shadow-report', report,
        '--commit-sha', 'c'.repeat(40), '--run-id', '42',
        '--selector-generation', '11', '--rehome-generation', '4'
      ])
    }
  } finally {
    process.stdout.write = write
    await rm(temporary, { recursive: true, force: true })
  }
  assert.deepEqual(printed.map((line) => JSON.parse(line).paceVerdict), ['PASS', 'UNVERIFIED'])
})

// The dispatch choice list, the validator's closed set, and the job's transition wait have to
// agree, or the form offers a pace the gate refuses or the wait outlives the 20-min token.
test('the workflows offer exactly the closed set and scale the drain wait with it', () => {
  const dispatch = readRelayWorkflow('deploy-relay-production-same-cap.yml')
  const input = dispatch.slice(dispatch.indexOf('      drain-pace-window-ms:\n'))
  assert.match(input, /default: '300000'\n/)
  assert.deepEqual(
    JSON.parse(/options: (\[[^\]]+\])/.exec(input)[1].replaceAll("'", '"')).map(Number),
    SAME_CAP_DRAIN_PACE_WINDOWS_MS
  )
  const seal = dispatch.slice(dispatch.indexOf('\n  seal_canary:'))
  assert.match(
    seal,
    /name: relay-same-cap-shadow-gate-\$\{\{ fromJSON\(needs\.gate\.outputs\.cells\)\[0\] \}\}-\$\{\{ github\.run_id \}\}\.json\n/
  )
  assert.ok(seal.indexOf('download-artifact') < seal.indexOf('create-canary'))
  assert.match(seal, /--shadow-report "\$\{RUNNER_TEMP\}\/relay-same-cap-shadow-gate\/relay-same-cap-shadow-gate-\$\{\{ fromJSON\(needs\.gate\.outputs\.cells\)\[0\] \}\}-\$\{GITHUB_RUN_ID\}\.json"/)
  // The seal names the cell the gate normalized, never the raw input a padded form could carry.
  assert.doesNotMatch(seal.slice(0, seal.indexOf('\n  release_lease:')), /inputs\.cell-ids/)
  // The job uploads under the same normalized cell, which cell_1 receives as target-cell-id.
  assert.match(dispatch, /target-cell-id: \$\{\{ fromJSON\(needs\.gate\.outputs\.cells\)\[0\] \}\}/)
  for (const command of ['validate', 'verify-canary', 'create-canary']) {
    const at = dispatch.indexOf(`relay-production-same-cap-wave.mjs ${command}`)
    assert.notEqual(at, -1, command)
    const end = dispatch.indexOf('\n\n', at)
    assert.match(dispatch.slice(at, end), /--drain-pace-window-ms "\$\{/, command)
  }
  assert.equal(
    dispatch.match(/\n      drain-pace-window-ms: \$\{\{ inputs\.drain-pace-window-ms \}\}\n/g).length,
    10
  )
  const job = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')
  assert.match(job, /\n      DRAIN_PACE_WINDOW_MS: \$\{\{ inputs\.drain-pace-window-ms \}\}\n/)
  assert.doesNotMatch(job, /DRAIN_PACE_WINDOW_MS: '/)
  assert.match(job, /cell-class \\\n\s+--cell-id "\$\{TARGET_CELL_ID\}" --drain-pace-window-ms "\$\{DRAIN_PACE_WINDOW_MS\}"/)
  // The 15-min migration lease plus the window: exactly today's 20 min at the default.
  assert.match(job, /--timeout-ms "\$\(\(900000 \+ DRAIN_PACE_WINDOW_MS\)\)"/)
  assert.equal(900_000 + SAME_CAP_DRAIN_PACE_WINDOWS_MS[0], 1_200_000)
  assert.ok(Math.max(...SAME_CAP_DRAIN_PACE_WINDOWS_MS) === DEFAULT_SAME_CAP_DRAIN_PACE_WINDOW_MS)
})
