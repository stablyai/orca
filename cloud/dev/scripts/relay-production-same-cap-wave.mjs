import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { requireSameEvidenceCode } from './relay-evidence-code-provenance.mjs'

// Migration-only by policy: zero hosts and no reservation, so a wave rolls one without
// displacing anybody. It enters and must leave migration-only, never general.
export const SAME_CAP_MIGRATION_ONLY_CELLS = ['production-gce-c17', 'production-gce-c18']

export const SAME_CAP_CELLS = [
  'production-gce-c7', 'production-gce-c8', 'production-gce-c9', 'production-gce-c10',
  'production-gce-c13', 'production-gce-c14', 'production-gce-c15', 'production-gce-c16',
  'production-gce-c19', 'production-gce-c20', 'production-gce-c21', 'production-gce-c22',
  'production-gce-c23', 'production-gce-c24', 'production-gce-c25', 'production-gce-c26',
  'production-gce-c27', 'production-gce-c28', 'production-gce-c29', 'production-gce-c30',
  ...SAME_CAP_MIGRATION_ONLY_CELLS
]

// A general cell's wave isolates and restores it, advancing the selector twice; a
// migration-only cell's isolate and restore are both no-ops, so its wave advances nothing.
export function selectorWaveDelta(cellId) {
  return SAME_CAP_MIGRATION_ONLY_CELLS.includes(cellId) ? 0 : 2
}

export function entryAdmission(cellId) {
  return SAME_CAP_MIGRATION_ONLY_CELLS.includes(cellId) ? 'migration-only' : 'general'
}

function digest(value, name) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${name} is invalid`)
  return value
}

function cells(value) {
  const parsed = value.split(',').map((cell) => cell.trim()).filter(Boolean)
  if (
    parsed.length < 1 ||
    parsed.length > 10 ||
    new Set(parsed).size !== parsed.length ||
    parsed.some((cell) => !SAME_CAP_CELLS.includes(cell))
  ) throw new Error('same-cap wave cells are invalid')
  // Every later cell offsets from one per-wave selector delta, and the two classes
  // have different ones, so a mixed wave has no single offset any cell could use.
  if (new Set(parsed.map(selectorWaveDelta)).size > 1) {
    throw new Error('same-cap wave cells must be all general or all migration-only')
  }
  return parsed
}

// Break-glass: the aggregate 15-minute monitor gate is skipped, nothing else is.
// Returns null when no override was requested, and throws on a partial or
// mismatched one so a malformed override can never reach a mutation.
export function gateOverrideAuthorization(input, targetDigest, mutation) {
  const reason = input.gateOverrideReason ?? ''
  const confirmation = input.gateOverrideConfirmation ?? ''
  if (!reason && !confirmation) return null
  if (!mutation) throw new Error('verify does not accept a monitor gate override')
  if (confirmation !== `SKIP_RELAY_MONITOR_GATE ${targetDigest}`) {
    throw new Error('gate override confirmation does not match the exact target digest')
  }
  // Printable single-line only: this reason is rendered into the run summary and
  // sealed into the canary artifact.
  if (!/^[\x20-\x7e]{12,500}$/.test(reason)) {
    throw new Error('gate override reason must be 12 to 500 printable characters on one line')
  }
  return { reason, confirmation }
}

export function validateSameCapWave(input) {
  if (!['verify', 'canary-apply', 'batch-apply', 'rollback'].includes(input.mode)) {
    throw new Error('same-cap wave mode is invalid')
  }
  const selected = cells(input.cellIds)
  const targetDigest = digest(input.targetDigest, 'target digest')
  const rollbackDigest = digest(input.rollbackDigest, 'rollback digest')
  if (targetDigest === rollbackDigest) throw new Error('target and rollback digests must differ')
  if (input.mode === 'canary-apply' && selected.length !== 1) {
    throw new Error('canary mode requires exactly one cell')
  }
  // Ten is the wave workflow's statically declared serial cell-job chain, cell_1..cell_10.
  if (input.mode === 'batch-apply' && (selected.length < 2 || selected.length > 10)) {
    throw new Error('batch mode requires two to ten cells')
  }
  // Later waves expect the selector to advance by exactly 2 per predecessor,
  // which a resumed rollback cell (isolate skipped, +1) violates.
  if (input.mode === 'rollback' && selected.length !== 1) {
    throw new Error('rollback mode requires exactly one cell')
  }
  const mutation = input.mode !== 'verify'
  const expectedConfirmation = input.mode === 'rollback'
    ? `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} ${selected.join(',')}`
    : `ROLL_RELAY_SAME_CAP ${targetDigest} ${selected.join(',')}`
  if (mutation && input.confirmation !== expectedConfirmation) {
    throw new Error('same-cap confirmation does not match the exact digest and cells')
  }
  if (!mutation && input.confirmation) throw new Error('verify does not accept confirmation')
  const gateOverride = gateOverrideAuthorization(input, targetDigest, mutation)
  if (input.mode === 'batch-apply' && !/^[1-9][0-9]*$/.test(input.canaryRunId ?? '')) {
    throw new Error('batch mode requires a canary run ID')
  }
  if (input.mode !== 'batch-apply' && input.canaryRunId) {
    throw new Error('only batch mode accepts a canary run ID')
  }
  return { cells: selected, targetDigest, rollbackDigest, gateOverride }
}

export function canaryAuthority(input) {
  const wave = validateSameCapWave({ ...input, mode: 'canary-apply', canaryRunId: '' })
  if (!/^[0-9a-f]{40}$/.test(input.commitSha ?? '')) throw new Error('commit SHA is invalid')
  if (!/^[1-9][0-9]*$/.test(input.runId ?? '')) throw new Error('run ID is invalid')
  const selectorGeneration = Number(input.selectorGeneration)
  const rehomeGeneration = Number(input.rehomeGeneration)
  if (!Number.isSafeInteger(selectorGeneration) || selectorGeneration < 0) {
    throw new Error('selector generation is invalid')
  }
  if (!Number.isSafeInteger(rehomeGeneration) || rehomeGeneration < 0) {
    throw new Error('rehome generation is invalid')
  }
  return {
    v: 1,
    commitSha: input.commitSha,
    runId: input.runId,
    cellId: wave.cells[0],
    targetDigest: wave.targetDigest,
    rollbackDigest: wave.rollbackDigest,
    selectorGeneration: selectorGeneration + selectorWaveDelta(wave.cells[0]),
    rehomeGeneration,
    // Audit trail, not authority: a batch reusing this canary is authorized by
    // its own confirmation, so verification below neither requires nor forbids it.
    gateOverride: wave.gateOverride === null ? null : {
      ...wave.gateOverride,
      actor: input.actor ?? ''
    }
  }
}

export function verifyCanaryAuthority(authority, expected, repositoryRoot) {
  const selectorGeneration = Number(expected.selectorGeneration)
  // A mixed wave is already rejected, so the batch's first cell names the whole batch's class.
  const batchAdmission = entryAdmission(cells(expected.cellIds ?? '')[0])
  if (
    authority?.v !== 1 ||
    !/^[0-9a-f]{40}$/.test(authority.commitSha ?? '') ||
    authority.runId !== expected.runId ||
    authority.targetDigest !== expected.targetDigest ||
    authority.rollbackDigest !== expected.rollbackDigest ||
    !Number.isSafeInteger(authority.selectorGeneration) ||
    authority.selectorGeneration < 0 ||
    !Number.isSafeInteger(selectorGeneration) ||
    selectorGeneration < authority.selectorGeneration ||
    authority.rehomeGeneration !== Number(expected.rehomeGeneration) ||
    !SAME_CAP_CELLS.includes(authority.cellId)
  ) throw new Error('canary authority does not match this batch')
  // A migration-only cell carries no hosts and a different cap, so rolling it proves nothing
  // about a general batch, and its wave advances a different selector delta.
  if (entryAdmission(authority.cellId) !== batchAdmission) {
    throw new Error(
      `canary authority cell ${authority.cellId} is ${entryAdmission(authority.cellId)}, ` +
      `but this batch is ${batchAdmission}`
    )
  }
  // Each cell checks exact live selector state; later batches may reuse this control epoch's canary.
  requireSameEvidenceCode({
    sealedSha: authority.commitSha,
    currentSha: expected.commitSha,
    label: 'relay same-cap canary authority',
    repositoryRoot
  })
  return authority
}

function values(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('invalid arguments')
    }
    result[argv[index].slice(2)] = argv[index + 1]
  }
  return result
}

export function main(argv = process.argv.slice(2)) {
  const command = argv.shift()
  const input = values(argv)
  if (command === 'validate') {
    const wave = validateSameCapWave({
      mode: input.mode,
      cellIds: input['cell-ids'],
      targetDigest: input['target-digest'],
      rollbackDigest: input['rollback-digest'],
      confirmation: input.confirmation,
      canaryRunId: input['canary-run-id'],
      gateOverrideReason: input['gate-override-reason'],
      gateOverrideConfirmation: input['gate-override-confirmation']
    })
    process.stdout.write(`${JSON.stringify(wave.cells)}\n`)
    return
  }
  if (command === 'create-canary') {
    process.stdout.write(`${JSON.stringify(canaryAuthority({
      mode: 'canary-apply',
      cellIds: input['cell-id'],
      targetDigest: input['target-digest'],
      rollbackDigest: input['rollback-digest'],
      confirmation: input.confirmation,
      commitSha: input['commit-sha'],
      runId: input['run-id'],
      selectorGeneration: input['selector-generation'],
      rehomeGeneration: input['rehome-generation'],
      gateOverrideReason: input['gate-override-reason'],
      gateOverrideConfirmation: input['gate-override-confirmation'],
      actor: input.actor
    }))}\n`)
    return
  }
  if (command === 'cell-class') {
    const cellId = input['cell-id']
    if (!SAME_CAP_CELLS.includes(cellId)) throw new Error('same-cap wave cells are invalid')
    process.stdout.write(`${JSON.stringify({
      entryAdmission: entryAdmission(cellId),
      selectorWaveDelta: selectorWaveDelta(cellId)
    })}\n`)
    return
  }
  if (command === 'verify-canary') {
    verifyCanaryAuthority(JSON.parse(readFileSync(input.file, 'utf8')), {
      commitSha: input['commit-sha'],
      runId: input['run-id'],
      cellIds: input['cell-ids'],
      targetDigest: input['target-digest'],
      rollbackDigest: input['rollback-digest'],
      selectorGeneration: input['selector-generation'],
      rehomeGeneration: input['rehome-generation']
    })
    return
  }
  throw new Error('unknown same-cap wave command')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
