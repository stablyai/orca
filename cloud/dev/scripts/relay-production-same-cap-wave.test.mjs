import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  SAME_CAP_CELLS,
  SAME_CAP_MIGRATION_ONLY_CELLS,
  canaryAuthority,
  entryAdmission,
  main,
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
  assert.deepEqual(validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c30',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c30`
  }).cells, ['production-gce-c30'])
  assert.throws(() => validateSameCapWave({
    mode: 'canary-apply',
    cellIds: 'production-gce-c31',
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} production-gce-c31`
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

test('rolls the migration-only cells but never mixes the two classes in one wave', () => {
  for (const cellId of SAME_CAP_MIGRATION_ONLY_CELLS) {
    assert.equal(SAME_CAP_CELLS.includes(cellId), true, cellId)
    assert.equal(entryAdmission(cellId), 'migration-only', cellId)
    assert.deepEqual(validateSameCapWave({
      mode: 'canary-apply',
      cellIds: cellId,
      targetDigest,
      rollbackDigest,
      confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellId}`
    }).cells, [cellId])
  }
  const cellIds = 'production-gce-c17,production-gce-c18'
  assert.deepEqual(validateSameCapWave({
    mode: 'batch-apply',
    cellIds,
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${cellIds}`,
    canaryRunId: '42'
  }).cells, ['production-gce-c17', 'production-gce-c18'])
  // Until its canary promotes it, a same-cap restore must hand C30 back isolated, never activated.
  assert.equal(entryAdmission('production-gce-c30'), 'migration-only')
  const asiaMixed = 'production-gce-c29,production-gce-c30'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: asiaMixed,
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${asiaMixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
  // A mixed wave has no single selector delta for its later cells to offset from.
  const mixed = 'production-gce-c7,production-gce-c17'
  assert.throws(() => validateSameCapWave({
    mode: 'batch-apply',
    cellIds: mixed,
    targetDigest,
    rollbackDigest,
    confirmation: `ROLL_RELAY_SAME_CAP ${targetDigest} ${mixed}`,
    canaryRunId: '42'
  }), /all general or all migration-only/)
})

test('seals a migration-only canary at the generation its wave leaves behind', () => {
  const seal = (cellId) => canaryAuthority({
    cellIds: cellId,
    targetDigest,
    rollbackDigest,
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
    selectorGeneration: '11',
    rehomeGeneration: '4'
  }).cellId, 'production-gce-c17')
})

test('reports each approved cell\'s class and selector delta', () => {
  const printed = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk) => printed.push(String(chunk))
  try {
    main(['cell-class', '--cell-id', 'production-gce-c17'])
    main(['cell-class', '--cell-id', 'production-gce-c7'])
  } finally {
    process.stdout.write = write
  }
  assert.deepEqual(printed.map((line) => JSON.parse(line)), [
    { entryAdmission: 'migration-only', selectorWaveDelta: 0 },
    { entryAdmission: 'general', selectorWaveDelta: 2 }
  ])
  assert.throws(() => main(['cell-class', '--cell-id', 'production-gce-c12']), /cells are invalid/)
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
    cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest,
    rollbackDigest,
    selectorGeneration: '13',
    rehomeGeneration: '4'
  }).cellId, 'production-gce-c7')
  assert.throws(() => verifyCanaryAuthority(authority, {
    commitSha: 'd'.repeat(40),
    runId: '42',
    cellIds: 'production-gce-c8,production-gce-c9',
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
    commitSha: 'c'.repeat(40), runId: '42', cellIds: 'production-gce-c8,production-gce-c9',
    targetDigest, rollbackDigest, selectorGeneration: '21', rehomeGeneration: '4'
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
      cellIds: 'production-gce-c8,production-gce-c9',
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
    cellIds: 'production-gce-c8,production-gce-c9',
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

function sealedCanary(cellId) {
  return canaryAuthority({
    cellIds: cellId,
    targetDigest,
    rollbackDigest,
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

async function runVerifyCanaryStep(authority, cellIds) {
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
        REHOME_GENERATION: '4'
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
})
