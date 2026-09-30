import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { PRODUCTION_CAPACITY_CELL_IDS } from './prepare-relay-production-capacity-canary.mjs'

const APPROVED_CELLS = new Set(PRODUCTION_CAPACITY_CELL_IDS)

function argumentsByName(argv, allowed) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!argument?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error('capacity wave arguments are invalid')
    }
    const name = argument.slice(2)
    if (!allowed.has(name) || name in values) {
      throw new Error(`capacity wave argument --${name} is invalid`)
    }
    values[name] = value
  }
  return values
}

export function parseCapacityWave(waveCellIds, confirmation) {
  const cells = waveCellIds.split(',')
  if (
    cells.length < 2 ||
    cells.length > 4 ||
    cells.some((cell) => !APPROVED_CELLS.has(cell)) ||
    new Set(cells).size !== cells.length ||
    cells.join(',') !== waveCellIds
  ) {
    throw new Error('capacity wave must contain two to four unique approved cells')
  }
  if (confirmation !== `RAISE_SELECTED_WAVE_TO_1000 ${waveCellIds}`) {
    throw new Error('capacity wave confirmation does not match the selected cells')
  }
  return cells
}

function exactMembership(membership) {
  const keys = ['existingOnly', 'migrationOnly', 'general']
  if (!keys.every((key) => Array.isArray(membership?.[key]))) return false
  const cells = keys.flatMap((key) => membership[key])
  return cells.every((cell) => typeof cell === 'string') && new Set(cells).size === cells.length
}

export function capacityWavePreflightState(state, waveCellIds, waveIndex, targetCellId) {
  const cells = parseCapacityWave(
    waveCellIds,
    `RAISE_SELECTED_WAVE_TO_1000 ${waveCellIds}`
  )
  const index = Number(waveIndex)
  const membership = state.expectedSelector?.membership
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= cells.length ||
    targetCellId !== cells[index] ||
    state.schemaVersion !== 4 ||
    state.environment !== 'production' ||
    state.preDrainDryRun !== true ||
    state.migrationPolicy !== 'capacity-transition' ||
    state.recoverySourceCellId !== null ||
    state.capacityCellId !== cells[0] ||
    !Number.isSafeInteger(state.expectedSelector?.generation) ||
    !exactMembership(membership) ||
    !cells.every((cell) => membership.general.includes(cell)) ||
    state.sampleCount < 16 ||
    state.frozenAt !== null ||
    typeof state.completedAt !== 'string'
  ) {
    throw new Error('capacity wave evidence does not match this step')
  }
  return {
    schemaVersion: 4,
    environment: 'production',
    expectedSelector: {
      generation: state.expectedSelector.generation + index * 2,
      membership
    },
    migrationPolicy: 'capacity-transition',
    recoverySourceCellId: null,
    capacityCellId: targetCellId
  }
}

export function capacityWaveResumePreflightState(state, waveCellIds, targetCellId) {
  const cells = parseCapacityWave(
    waveCellIds,
    `RAISE_SELECTED_WAVE_TO_1000 ${waveCellIds}`
  )
  const index = cells.indexOf(targetCellId)
  const base = capacityWavePreflightState(
    state,
    waveCellIds,
    String(index),
    targetCellId
  )
  const membership = base.expectedSelector.membership
  const general = membership.general.filter((cell) => cell !== targetCellId)
  const capacityCellId = general.includes(state.capacityCellId)
    ? state.capacityCellId
    : cells.find((cell) => general.includes(cell))
  if (!capacityCellId) throw new Error('capacity wave resume has no general evidence cell')
  return {
    ...base,
    expectedSelector: {
      generation: base.expectedSelector.generation + 1,
      membership: {
        existingOnly: membership.existingOnly,
        migrationOnly: [...membership.migrationOnly, targetCellId].sort(),
        general
      }
    },
    capacityCellId
  }
}

async function main(argv) {
  const [command, ...arguments_] = argv
  if (command === 'validate') {
    const values = argumentsByName(
      arguments_,
      new Set(['wave-cell-ids', 'confirmation'])
    )
    process.stdout.write(`${JSON.stringify(parseCapacityWave(
      values['wave-cell-ids'] ?? '',
      values.confirmation ?? ''
    ))}\n`)
    return
  }
  if (command === 'build-preflight' || command === 'build-resume-preflight') {
    const values = argumentsByName(
      arguments_,
      new Set([
        'state-file',
        'wave-cell-ids',
        ...(command === 'build-preflight' ? ['wave-index'] : []),
        'target-cell-id',
        'output-file'
      ])
    )
    const state = JSON.parse(await readFile(values['state-file'] ?? '', 'utf8'))
    const preflight = command === 'build-preflight'
      ? capacityWavePreflightState(
          state,
          values['wave-cell-ids'] ?? '',
          values['wave-index'] ?? '',
          values['target-cell-id'] ?? ''
        )
      : capacityWaveResumePreflightState(
          state,
          values['wave-cell-ids'] ?? '',
          values['target-cell-id'] ?? ''
        )
    await writeFile(
      values['output-file'] ?? '',
      `${JSON.stringify(preflight)}\n`,
      { mode: 0o600 }
    )
    return
  }
  throw new Error('capacity wave command is invalid')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'capacity wave failed')
    process.exitCode = 1
  })
}
