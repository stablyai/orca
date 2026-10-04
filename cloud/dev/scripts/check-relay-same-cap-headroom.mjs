import { pathToFileURL } from 'node:url'
import { fetchAdminOnceMore } from './relay-admin-transient-retry.mjs'

// Drained hosts that find no free slot keep redialling and pin the drained cell (c28,
// 2026-10-01). Hosts are counted as controls, but each moved host also brings its splices;
// the 20% margin is for those.
export const MAX_HEADROOM_FRACTION = 0.8

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`)
  return value
}

export function parseHeadroomArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['director-origin', 'cell-origin', 'cell-id', 'general-cells']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  for (const key of ['director-origin', 'cell-origin']) {
    const url = new URL(values[key])
    if (url.protocol !== 'https:' || url.origin !== values[key]) {
      throw new Error('origins must be canonical HTTPS origins')
    }
  }
  const generalCells = values['general-cells'] === 'none'
    ? []
    : values['general-cells'].split(',')
  if (
    new Set(generalCells).size !== generalCells.length ||
    generalCells.some((cellId) => !/^[a-z0-9-]+$/.test(cellId))
  ) {
    throw new Error('--general-cells is invalid')
  }
  return {
    directorOrigin: values['director-origin'],
    cellOrigin: values['cell-origin'],
    cellId: values['cell-id'],
    generalCells
  }
}

async function adminJson(fetchImpl, url, token, body, wait) {
  const response = await fetchAdminOnceMore(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    },
    { wait }
  )
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned ${response.status}`)
  return json
}

// A cell whose capacity view is stale, absent, or not general offers no slot we can count.
// Placement admits while enforced units plus outstanding reservations stay under the pause.
function freeSlots(status) {
  const capacity = status.connectionCapacity
  if (
    status.enabled !== true ||
    status.admissionState !== 'general' ||
    capacity === null ||
    capacity === undefined ||
    capacity.heartbeatFresh !== true
  ) {
    return 0
  }
  const pause = count(capacity.normalAdmissionPause, 'normal admission pause')
  const used = Math.max(
    count(capacity.observedConnections, 'observed connections'),
    count(capacity.enforcedConnectionUnits, 'enforced connection units')
  )
  const reserved = count(capacity.pendingControlReservations, 'pending control reservations')
  return Math.max(0, pause - used - reserved)
}

export async function checkSameCapHeadroom(config, overrides = {}) {
  const fetchImpl = overrides.fetch ?? fetch
  const wait = overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const token = overrides.token ?? process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192) throw new Error('admin identity token is unavailable')
  const cellStatus = async (cellId) => {
    const { status } = await adminJson(
      fetchImpl,
      `${config.directorOrigin}/v1/admin/cell-status`,
      token,
      { v: 1, cellId },
      wait
    )
    if (status?.cellId !== cellId) throw new Error('director status does not match the cell')
    return status
  }
  const runtime = await adminJson(
    fetchImpl,
    `${config.cellOrigin}/v1/admin/runtime-status`,
    token,
    { v: 1 },
    wait
  )
  if (runtime.role !== 'cell' || runtime.cellId !== config.cellId) {
    throw new Error('runtime status does not match the cell')
  }
  const targetHosts = count(runtime.runtime?.controls, 'target host controls')
  const targetRegion = (await cellStatus(config.cellId)).region ?? null
  const cells = []
  for (const cellId of config.generalCells) {
    if (cellId === config.cellId) continue
    const status = await cellStatus(cellId)
    cells.push({ cellId, region: status.region ?? null, freeSlots: freeSlots(status) })
  }
  const total = (filter) =>
    cells.filter(filter).reduce((sum, cell) => sum + cell.freeSlots, 0)
  const sameRegion = (cell) => targetRegion !== null && cell.region === targetRegion
  const free = total(() => true)
  const allowedHosts = Math.floor(free * MAX_HEADROOM_FRACTION)
  return {
    cellId: config.cellId,
    region: targetRegion,
    targetHosts,
    freeSlots: free,
    sameRegionFreeSlots: total(sameRegion),
    otherRegionFreeSlots: total((cell) => !sameRegion(cell)),
    allowedHosts,
    sufficient: targetHosts <= allowedHosts,
    cells
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await checkSameCapHeadroom(parseHeadroomArguments(argv))
  process.stdout.write(`${JSON.stringify({ event: 'relay_same_cap_headroom', ...result })}\n`)
  if (!result.sufficient) {
    throw new Error(
      `${result.targetHosts} hosts on ${result.cellId} exceed ` +
        `${MAX_HEADROOM_FRACTION * 100}% of ${result.freeSlots} free general-cell slots`
    )
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
