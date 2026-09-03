import { pathToFileURL } from 'node:url'
import {
  applyExactAdmissionSelector,
  inspectAdmissionSelector,
  membershipWithStates,
  selectorCellState
} from './relay-admission-selector.mjs'

const DIRECTOR_ORIGIN = 'https://relay.onorca.dev'
export const PRODUCTION_CAPACITY_CELL_IDS = [
  'production-gce-c7',
  'production-gce-c8',
  'production-gce-c9',
  'production-gce-c10',
  'production-gce-c13',
  'production-gce-c14',
  'production-gce-c15',
  'production-gce-c16',
  'production-gce-c19',
  'production-gce-c20',
  'production-gce-c21',
  'production-gce-c22',
  'production-gce-c23',
  'production-gce-c24',
  'production-gce-c25',
  'production-gce-c26'
]

function cellOrigin(cellId) {
  return `https://${cellId.slice('production-gce-'.length)}.relay.onorca.dev`
}

export function parseProductionCapacityCellArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  if (!['isolate', 'drain', 'activate'].includes(values.mode)) {
    throw new Error('--mode must be isolate, drain, or activate')
  }
  const cellId = values['cell-id']
  if (!PRODUCTION_CAPACITY_CELL_IDS.includes(cellId)) {
    throw new Error('production capacity target is not approved')
  }
  const expectedCellOrigin = cellOrigin(cellId)
  if (
    values['director-origin'] !== DIRECTOR_ORIGIN ||
    values['cell-origin'] !== expectedCellOrigin
  ) {
    throw new Error('production capacity target origin is not exact')
  }
  return {
    directorOrigin: DIRECTOR_ORIGIN,
    cellOrigin: expectedCellOrigin,
    cellId,
    mode: values.mode
  }
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${label} returned ${response.status}`)
  return body
}

export async function prepareProductionCapacityCell(config, overrides = {}) {
  const fetchImpl = overrides.fetch ?? fetch
  const token = overrides.token ?? process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192) throw new Error('admin identity token is unavailable')
  const postAt = async (origin, path, body) =>
    await responseJson(
      await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      }),
      path
    )
  const post = async (path, body) => await postAt(config.directorOrigin, path, body)
  if (config.mode === 'drain') {
    await postAt(config.cellOrigin, '/v1/admin/drain', { v: 1, graceMs: 0 })
    return { changed: false, drained: true }
  }
  const before = await inspectAdmissionSelector(post)
  const state = selectorCellState(before.selector, config.cellId)
  if (state === 'existing-only') throw new Error('production capacity target is irreversible')
  const desiredState = config.mode === 'isolate' ? 'migration-only' : 'general'
  const membership = membershipWithStates(before.selector, { [config.cellId]: desiredState })
  const result = await applyExactAdmissionSelector(post, membership, {
    expectedCurrentSelector: before.selector
  })
  return {
    changed: result.changed,
    generation: result.selector.generation,
    admissionState: desiredState
  }
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseProductionCapacityCellArguments(argv)
  const result = await prepareProductionCapacityCell(config)
  process.stdout.write(
    `${JSON.stringify({ event: 'relay_production_capacity_canary', cellId: config.cellId, mode: config.mode, ...result })}\n`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
