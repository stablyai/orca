import { pathToFileURL } from 'node:url'
import { fetchAdminOnceMore } from './relay-admin-transient-retry.mjs'
import {
  applyExactAdmissionSelector,
  inspectAdmissionSelector,
  membershipWithStates,
  selectorCellState
} from './relay-admission-selector.mjs'
import { SAME_CAP_CELLS } from './relay-production-same-cap-wave.mjs'

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

// The same-cap roll covers the Asia cells the US-only capacity rollout never touches.
const APPROVED_CELL_LISTS = { 'same-cap': SAME_CAP_CELLS }

// Matches the cell's own cap on /v1/admin/drain.
const MAX_PACE_WINDOW_MS = 5 * 60 * 1_000

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
  const approvedList = values['approved-cells']
  if (approvedList !== undefined && !APPROVED_CELL_LISTS[approvedList]) {
    throw new Error('--approved-cells is not a known allowlist')
  }
  const approvedCellIds = approvedList === undefined
    ? PRODUCTION_CAPACITY_CELL_IDS
    : APPROVED_CELL_LISTS[approvedList]
  const cellId = values['cell-id']
  if (!approvedCellIds.includes(cellId)) {
    throw new Error('production capacity target is not approved')
  }
  const expectedCellOrigin = cellOrigin(cellId)
  if (
    values['director-origin'] !== DIRECTOR_ORIGIN ||
    values['cell-origin'] !== expectedCellOrigin
  ) {
    throw new Error('production capacity target origin is not exact')
  }
  const paceWindowMs = values['pace-window-ms'] === undefined
    ? 0
    : Number(values['pace-window-ms'])
  if (
    !Number.isSafeInteger(paceWindowMs) ||
    paceWindowMs < 0 ||
    paceWindowMs > MAX_PACE_WINDOW_MS
  ) {
    throw new Error('--pace-window-ms must be an integer between 0 and 300000')
  }
  return {
    directorOrigin: DIRECTOR_ORIGIN,
    cellOrigin: expectedCellOrigin,
    cellId,
    mode: values.mode,
    paceWindowMs
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
  const postRaw = async (origin, path, body) =>
    await fetchAdminOnceMore(
      fetchImpl,
      `${origin}${path}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      },
      { wait: overrides.wait }
    )
  const postAt = async (origin, path, body) =>
    await responseJson(await postRaw(origin, path, body), path)
  const post = async (path, body) => await postAt(config.directorOrigin, path, body)
  if (config.mode === 'drain') {
    const paceWindowMs = config.paceWindowMs ?? 0
    if (paceWindowMs > 0) {
      const paced = await postRaw(config.cellOrigin, '/v1/admin/drain', {
        v: 1,
        graceMs: 0,
        paceWindowMs
      })
      if (paced.ok) {
        await paced.json().catch(() => ({}))
        return { changed: false, drained: true, paceWindowMs }
      }
      // A cell still on an image without paced drain rejects the unknown field outright.
      // An unpaced drain is the behaviour that cell already has, so fall back to it.
      if (paced.status !== 400) throw new Error(`/v1/admin/drain returned ${paced.status}`)
      await paced.json().catch(() => ({}))
    }
    await postAt(config.cellOrigin, '/v1/admin/drain', { v: 1, graceMs: 0 })
    return { changed: false, drained: true, paceWindowMs: 0 }
  }
  const before = await inspectAdmissionSelector(post)
  const state = selectorCellState(before.selector, config.cellId)
  if (state === 'existing-only') throw new Error('production capacity target is irreversible')
  const desiredState = config.mode === 'isolate' ? 'migration-only' : 'general'
  const membership = membershipWithStates(before.selector, { [config.cellId]: desiredState })
  const result = await applyExactAdmissionSelector(post, membership, {
    expectedCurrentSelector: before.selector,
    // The stamp that tells the director this cell is parked for a restart rather
    // than held back as capacity, so it may re-place the hosts still on it. The
    // activate branch omits it, and moving to 'general' clears it in the same
    // statement that writes the state.
    ...(config.mode === 'isolate' ? { rollIsolatedCells: [config.cellId] } : {})
  })
  return {
    changed: result.changed,
    generation: result.selector.generation,
    admissionState: desiredState,
    rollIsolated: config.mode === 'isolate'
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
