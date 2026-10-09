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
  'production-gce-c31', 'production-gce-c32', 'production-gce-c33', 'production-gce-c34',
  ...SAME_CAP_MIGRATION_ONLY_CELLS
]

// A general cell's wave isolates and restores it, advancing the selector twice; a
// migration-only cell's isolate and restore are both no-ops, so its wave advances nothing.
export function selectorWaveDelta(cellId) {
  return SAME_CAP_MIGRATION_ONLY_CELLS.includes(cellId) ? 0 : 2
}

// The cell spreads its drain sends evenly over this window (host-session-registry.ts drain), so
// it sets the re-placement arrival rate: hosts / window. A closed set, stepped down one rung at a
// time per cloud/docs/relay-workflows.md; the first entry is the default every wave used before.
// The slower windows are for cells whose 300 s drain browned out the database (c28, 10-07).
export const SAME_CAP_DRAIN_PACE_WINDOWS_MS = [300_000, 60_000, 30_000, 900_000, 1_200_000]
export const DEFAULT_SAME_CAP_DRAIN_PACE_WINDOW_MS = SAME_CAP_DRAIN_PACE_WINDOWS_MS[0]

// Only US general cells may drain faster than the default. An Asia drain is bounded by its
// targets' own accept rate (~4-6 hosts/s per cell over 176 ms round trips), and a migration-only
// cell carries no hosts, so neither has anything to gain from a shorter window.
export const SAME_CAP_FAST_DRAIN_PACE_CELLS = [
  'production-gce-c7', 'production-gce-c8', 'production-gce-c9', 'production-gce-c10',
  'production-gce-c13', 'production-gce-c14', 'production-gce-c15', 'production-gce-c16',
  'production-gce-c19', 'production-gce-c20', 'production-gce-c21', 'production-gce-c22',
  'production-gce-c23', 'production-gce-c24', 'production-gce-c25', 'production-gce-c26',
  'production-gce-c32', 'production-gce-c33'
]

export function drainPaceWindowMs(value, cellIds) {
  const parsed = /^[1-9][0-9]*$/.test(value ?? '') ? Number(value) : Number.NaN
  if (!SAME_CAP_DRAIN_PACE_WINDOWS_MS.includes(parsed)) {
    throw new Error(
      `drain pace window must be one of ${SAME_CAP_DRAIN_PACE_WINDOWS_MS.join(', ')} ms`
    )
  }
  if (parsed < DEFAULT_SAME_CAP_DRAIN_PACE_WINDOW_MS) {
    const slow = cellIds.filter((cell) => !SAME_CAP_FAST_DRAIN_PACE_CELLS.includes(cell))
    if (slow.length > 0) {
      throw new Error(
        `drain pace window ${parsed} ms is for US general cells only, not ${slow.join(',')}`
      )
    }
  }
  return parsed
}

// The default keeps the confirmation every earlier wave typed; any other window must be named
// in it, so a dispatch cannot run a pace its confirmation did not state.
function confirmationPaceSuffix(paceWindowMs) {
  return paceWindowMs === DEFAULT_SAME_CAP_DRAIN_PACE_WINDOW_MS
    ? ''
    : ` drain-pace-window-ms=${paceWindowMs}`
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
  const paceWindowMs = drainPaceWindowMs(input.drainPaceWindowMs, selected)
  const mutation = input.mode !== 'verify'
  const expectedConfirmation = (input.mode === 'rollback'
    ? `ROLL_BACK_RELAY_SAME_CAP ${rollbackDigest} ${selected.join(',')}`
    : `ROLL_RELAY_SAME_CAP ${targetDigest} ${selected.join(',')}`) +
    confirmationPaceSuffix(paceWindowMs)
  if (mutation && input.confirmation !== expectedConfirmation) {
    throw new Error('same-cap confirmation does not match the exact digest and cells')
  }
  if (!mutation && input.confirmation) throw new Error('verify does not accept confirmation')
  if (input.mode === 'batch-apply' && !/^[1-9][0-9]*$/.test(input.canaryRunId ?? '')) {
    throw new Error('batch mode requires a canary run ID')
  }
  if (input.mode !== 'batch-apply' && input.canaryRunId) {
    throw new Error('only batch mode accepts a canary run ID')
  }
  return { cells: selected, targetDigest, rollbackDigest, drainPaceWindowMs: paceWindowMs }
}

const CANARY_PACE_VERDICTS = ['PASS', 'WARN', 'WOULD_BLOCK', 'UNVERIFIED']

// A pace is a host arrival rate (hosts / window), so a canary proves it only with a real cohort:
// at least about half the 692-782 hosts a US general cell carried on 10-02, keeping any batch
// cell within ~2x of the rate the canary actually drained at.
export const CANARY_MIN_DRAINED_HOSTS = 400

// The canary cell's own pace checks, trusted only from a report on this cell that drained enough
// hosts at this pace; a cell whose image fell back to an unpaced drain proved nothing about it.
export function canaryPaceVerdict(report, cellId, paceWindowMs) {
  if (
    report?.cellId !== cellId ||
    report.drain?.paceWindowMs !== paceWindowMs ||
    report.drain?.appliedPaceWindowMs !== paceWindowMs ||
    !(report.drain?.targetHosts >= CANARY_MIN_DRAINED_HOSTS) ||
    !CANARY_PACE_VERDICTS.includes(report.paceVerdict)
  ) return 'UNVERIFIED'
  return report.paceVerdict
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
    v: 2,
    commitSha: input.commitSha,
    runId: input.runId,
    cellId: wave.cells[0],
    targetDigest: wave.targetDigest,
    rollbackDigest: wave.rollbackDigest,
    drainPaceWindowMs: wave.drainPaceWindowMs,
    paceVerdict: canaryPaceVerdict(input.shadowReport, wave.cells[0], wave.drainPaceWindowMs),
    selectorGeneration: selectorGeneration + selectorWaveDelta(wave.cells[0]),
    rehomeGeneration
  }
}

export function verifyCanaryAuthority(authority, expected, repositoryRoot) {
  const selectorGeneration = Number(expected.selectorGeneration)
  // A mixed wave is already rejected, so the batch's first cell names the whole batch's class.
  const batchCells = cells(expected.cellIds ?? '')
  const batchAdmission = entryAdmission(batchCells[0])
  const batchPaceWindowMs = drainPaceWindowMs(expected.drainPaceWindowMs, batchCells)
  if (
    authority?.v !== 2 ||
    !/^[0-9a-f]{40}$/.test(authority.commitSha ?? '') ||
    authority.runId !== expected.runId ||
    authority.targetDigest !== expected.targetDigest ||
    authority.rollbackDigest !== expected.rollbackDigest ||
    !Number.isSafeInteger(authority.selectorGeneration) ||
    authority.selectorGeneration < 0 ||
    !Number.isSafeInteger(selectorGeneration) ||
    selectorGeneration < authority.selectorGeneration ||
    authority.rehomeGeneration !== Number(expected.rehomeGeneration) ||
    !SAME_CAP_CELLS.includes(authority.cellId) ||
    !SAME_CAP_DRAIN_PACE_WINDOWS_MS.includes(authority.drainPaceWindowMs) ||
    !CANARY_PACE_VERDICTS.includes(authority.paceVerdict)
  ) throw new Error('canary authority does not match this batch')
  // A canary proves its own pace and every slower one; a faster batch needs its own canary, and
  // falling back to a slower pace mid-ladder never does.
  if (batchPaceWindowMs < authority.drainPaceWindowMs) {
    throw new Error(
      `canary authority drained over ${authority.drainPaceWindowMs} ms, ` +
      `so it cannot authorize a batch draining over ${batchPaceWindowMs} ms`
    )
  }
  // A batch rolls up to ten cells back to back, so a faster one needs a canary whose own drain
  // passed; the default and anything slower stay available to any canary.
  if (
    batchPaceWindowMs < DEFAULT_SAME_CAP_DRAIN_PACE_WINDOW_MS &&
    authority.paceVerdict !== 'PASS'
  ) {
    throw new Error(
      `canary authority pace checks were ${authority.paceVerdict}, ` +
      `so it cannot authorize a batch draining over ${batchPaceWindowMs} ms`
    )
  }
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

// A missing or unreadable report seals UNVERIFIED rather than failing the seal: the default pace
// never needed one.
function readShadowReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
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
      drainPaceWindowMs: input['drain-pace-window-ms']
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
      drainPaceWindowMs: input['drain-pace-window-ms'],
      shadowReport: readShadowReport(input['shadow-report']),
      commitSha: input['commit-sha'],
      runId: input['run-id'],
      selectorGeneration: input['selector-generation'],
      rehomeGeneration: input['rehome-generation']
    }))}\n`)
    return
  }
  if (command === 'cell-class') {
    const cellId = input['cell-id']
    if (!SAME_CAP_CELLS.includes(cellId)) throw new Error('same-cap wave cells are invalid')
    process.stdout.write(`${JSON.stringify({
      entryAdmission: entryAdmission(cellId),
      selectorWaveDelta: selectorWaveDelta(cellId),
      drainPaceWindowMs: drainPaceWindowMs(input['drain-pace-window-ms'], [cellId])
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
      rehomeGeneration: input['rehome-generation'],
      drainPaceWindowMs: input['drain-pace-window-ms']
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
