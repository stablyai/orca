import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function argumentsFrom(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['current-json', 'topology-json', 'output', 'cell-ids', 'image-digest']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  return values
}

export function prepareRelayAsiaDirectorCells({ currentCells, topology, cellIds, imageDigest }) {
  if (!Array.isArray(currentCells) || !topology || Array.isArray(topology)) {
    throw new Error('director inputs are invalid')
  }
  const additions = cellIds.split(',').map((value) => value.trim()).filter(Boolean)
  if (
    additions.length === 0 ||
    new Set(additions).size !== additions.length
  ) throw new Error('director Asia additions are invalid')
  const currentIds = new Set(currentCells.map((cell) => cell.id))
  if (currentIds.size !== currentCells.length) throw new Error('current director cells contain duplicates')
  const normalizedCurrent = currentCells.map((cell) => ({
    ...cell,
    region: cell.region ?? 'us-central1'
  }))
  const desiredCells = additions.map((cellId) => {
    const cell = topology[cellId]
    if (
      !cell ||
      cell.region !== 'asia-east2' ||
      cell.capacity_requests !== 6_000 ||
      cell.database_pool_max !== 10 ||
      cell.connection_hard_cap !== 3_000 ||
      cell.connection_unobserved_bound !== 60 ||
      cell.initially_enabled !== false ||
      cell.image?.split('@')[1] !== imageDigest
    ) throw new Error(`${cellId} state output does not match the reviewed Asia shape`)
    return {
      id: cellId,
      url: cell.origin,
      capacityRequests: cell.capacity_requests,
      region: cell.region,
      initiallyEnabled: false,
      connectionHardCap: cell.connection_hard_cap,
      connectionUnobservedBound: cell.connection_unobserved_bound
    }
  })
  const desiredById = new Map(desiredCells.map((cell) => [cell.id, cell]))
  for (const current of normalizedCurrent) {
    const desired = desiredById.get(current.id)
    if (!desired) continue
    for (const [key, value] of Object.entries(desired)) {
      if (current[key] !== value) {
        throw new Error(`${current.id} director configuration differs from the reviewed Asia shape`)
      }
    }
  }
  const configured = new Set(normalizedCurrent.map((cell) => cell.id))
  return [...normalizedCurrent, ...desiredCells.filter((cell) => !configured.has(cell.id))]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const values = argumentsFrom(process.argv.slice(2))
  const result = prepareRelayAsiaDirectorCells({
    currentCells: JSON.parse(readFileSync(values['current-json'], 'utf8')),
    topology: JSON.parse(readFileSync(values['topology-json'], 'utf8')),
    cellIds: values['cell-ids'],
    imageDigest: values['image-digest']
  })
  writeFileSync(values.output, `${JSON.stringify(result)}\n`, { mode: 0o600 })
}
