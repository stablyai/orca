import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--capacity-service-account' || !argv[1]) {
    throw new Error('missing --capacity-service-account')
  }
  return argv[1]
}

export function classifyProductionCapacityDirector(state, capacityServiceAccount) {
  const currentIdentity = state.currentCapacityServiceAccount
  if (currentIdentity !== null && currentIdentity !== capacityServiceAccount) {
    throw new Error('director has an unexpected capacity identity')
  }
  const {
    baseCells,
    currentCells,
    capacityCellIds,
    targetCellId,
    targetHardCap
  } = state
  if (
    !Array.isArray(baseCells) ||
    !Array.isArray(currentCells) ||
    !Array.isArray(capacityCellIds) ||
    ![600, 1000].includes(targetHardCap) ||
    new Set(capacityCellIds).size !== capacityCellIds.length ||
    !capacityCellIds.includes(targetCellId) ||
    baseCells.length !== currentCells.length ||
    new Set(baseCells.map((cell) => cell?.id)).size !== baseCells.length ||
    new Set(currentCells.map((cell) => cell?.id)).size !== currentCells.length
  ) {
    throw new Error('director topology transition input is invalid')
  }
  const capacityCells = new Set(capacityCellIds)
  const normalizedCurrent = currentCells.map((current, index) => {
    const base = baseCells[index]
    if (
      typeof current?.id !== 'string' ||
      current.id !== base?.id
    ) {
      throw new Error('director topology cell identity is invalid')
    }
    if (!capacityCells.has(current.id)) {
      if (!isDeepStrictEqual(current, base)) {
        throw new Error('director topology changed outside the capacity rollout')
      }
      return current
    }
    if (
      base.connectionHardCap !== 1000 ||
      base.connectionUnobservedBound !== 60 ||
      ![600, 1000].includes(current.connectionHardCap) ||
      current.connectionUnobservedBound !== 60
    ) {
      throw new Error('director capacity rollout state is invalid')
    }
    return {
      ...current,
      connectionHardCap: base.connectionHardCap,
      connectionUnobservedBound: base.connectionUnobservedBound
    }
  })
  if (
    !isDeepStrictEqual(normalizedCurrent, baseCells) ||
    capacityCellIds.some((cellId) => !baseCells.some((cell) => cell.id === cellId))
  ) {
    throw new Error('director topology is outside the reviewed capacity envelope')
  }
  const withTargetCap = (hardCap) => currentCells.map((cell) =>
    cell.id === targetCellId
      ? { ...cell, connectionHardCap: hardCap, connectionUnobservedBound: 60 }
      : cell
  )
  const desiredCells = withTargetCap(targetHardCap)
  const predecessorCells = withTargetCap(targetHardCap === 600 ? 1000 : 600)
  const topologyPhase = isDeepStrictEqual(currentCells, desiredCells)
    ? 'desired'
    : isDeepStrictEqual(currentCells, predecessorCells)
      ? 'predecessor'
      : null
  if (!topologyPhase) throw new Error('director topology is not a reviewed transition state')
  return {
    topologyPhase,
    directorReady:
      topologyPhase === 'desired' && currentIdentity === capacityServiceAccount,
    desiredCells
  }
}

export function main(argv = process.argv.slice(2)) {
  const capacityServiceAccount = parseArguments(argv)
  const state = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(`${JSON.stringify({
    event: 'relay_production_capacity_director_classified',
    ...classifyProductionCapacityDirector(state, capacityServiceAccount)
  })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
