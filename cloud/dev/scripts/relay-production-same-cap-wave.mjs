import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SAME_CAP_CELLS = [
  'production-gce-c7', 'production-gce-c8', 'production-gce-c9', 'production-gce-c10',
  'production-gce-c13', 'production-gce-c14', 'production-gce-c15', 'production-gce-c16',
  'production-gce-c19', 'production-gce-c20', 'production-gce-c21', 'production-gce-c22',
  'production-gce-c23', 'production-gce-c24', 'production-gce-c25', 'production-gce-c26',
  'production-gce-c27', 'production-gce-c28', 'production-gce-c29'
]

function digest(value, name) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${name} is invalid`)
  return value
}

function cells(value) {
  const parsed = value.split(',').map((cell) => cell.trim()).filter(Boolean)
  if (
    parsed.length < 1 ||
    parsed.length > 4 ||
    new Set(parsed).size !== parsed.length ||
    parsed.some((cell) => !SAME_CAP_CELLS.includes(cell))
  ) throw new Error('same-cap wave cells are invalid')
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
  if (input.mode === 'batch-apply' && (selected.length < 2 || selected.length > 4)) {
    throw new Error('batch mode requires two to four cells')
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
  if (input.mode === 'batch-apply' && !/^[1-9][0-9]*$/.test(input.canaryRunId ?? '')) {
    throw new Error('batch mode requires a canary run ID')
  }
  if (input.mode !== 'batch-apply' && input.canaryRunId) {
    throw new Error('only batch mode accepts a canary run ID')
  }
  return { cells: selected, targetDigest, rollbackDigest }
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
    selectorGeneration: selectorGeneration + 2,
    rehomeGeneration
  }
}

export function verifyCanaryAuthority(authority, expected) {
  if (
    authority?.v !== 1 ||
    authority.commitSha !== expected.commitSha ||
    authority.runId !== expected.runId ||
    authority.targetDigest !== expected.targetDigest ||
    authority.rollbackDigest !== expected.rollbackDigest ||
    authority.selectorGeneration !== Number(expected.selectorGeneration) ||
    authority.rehomeGeneration !== Number(expected.rehomeGeneration) ||
    !SAME_CAP_CELLS.includes(authority.cellId)
  ) throw new Error('canary authority does not match this batch')
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
      canaryRunId: input['canary-run-id']
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
      rehomeGeneration: input['rehome-generation']
    }))}\n`)
    return
  }
  if (command === 'verify-canary') {
    verifyCanaryAuthority(JSON.parse(readFileSync(input.file, 'utf8')), {
      commitSha: input['commit-sha'],
      runId: input['run-id'],
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
