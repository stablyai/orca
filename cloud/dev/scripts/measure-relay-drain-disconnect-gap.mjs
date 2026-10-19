import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Per-desktop disconnect gap for one drained cell, read from log lines that already ship:
// the source cell's `control closed` line and the director's reconnect `assignment granted`
// line (drains send `reconnect: true`, so every drained desktop's grant carries `hinted=true`).
// Read-only: the operator exports both logs; this file never queries anything.

const CLOSE = /^\[orca-relay\] control closed host=(\S+) .*?\bsplices=(\d+) .*?\bcode=(\d+) reason=("(?:[^"\\]|\\.)*")/
const GRANT = /^\[orca-relay\] assignment granted lane=\S+ hinted=true host=(\S+) cell=(\S+)$/
// The cell's own drain close; a desktop closed this way had not moved yet, idle or not.
const DRAIN_CLOSE_REASON = 'resolve configured director'

function entryText(entry) {
  if (typeof entry.textPayload === 'string') return entry.textPayload
  if (typeof entry.jsonPayload?.message === 'string') return entry.jsonPayload.message
  return null
}

function entryTime(entry) {
  const at = Date.parse(entry.timestamp)
  if (!Number.isFinite(at)) throw new Error('log entry has no timestamp')
  return at
}

export function readDrainCloses(entries) {
  const closes = []
  for (const entry of entries) {
    const match = CLOSE.exec(entryText(entry) ?? '')
    if (!match) continue
    closes.push({
      host: match[1],
      splices: Number(match[2]),
      code: Number(match[3]),
      reason: JSON.parse(match[4]),
      at: entryTime(entry)
    })
  }
  // gcloud exports newest first; the measurement needs each host's earliest close.
  return closes.sort((left, right) => left.at - right.at)
}

export function readReconnectGrants(entries) {
  const grants = []
  for (const entry of entries) {
    const match = GRANT.exec(entryText(entry) ?? '')
    if (match) grants.push({ host: match[1], cellId: match[2], at: entryTime(entry) })
  }
  return grants.sort((left, right) => left.at - right.at)
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? null
  }
}

// `controlsAtDrainStart` is the denominator: hosts the cell held when the drain began,
// read from its runtime metrics line, so a desktop that never logged a close still counts.
// `drainEndedAt` closes the window: after it the rolled cell's new container serves new sessions,
// and their closes are not part of the drain. Grants after it still count, as the gap's far end.
export function measureDrainDisconnectGap({
  sourceCellId,
  drainStartedAt,
  drainEndedAt,
  controlsAtDrainStart,
  closes,
  grants,
  cellRegions = {}
}) {
  if (!Number.isFinite(drainStartedAt)) throw new Error('drain start time is invalid')
  if (!Number.isFinite(drainEndedAt) || drainEndedAt <= drainStartedAt) {
    throw new Error('drain end time is invalid')
  }
  const sourceRegion = cellRegions[sourceCellId]
  // First close per host after the drain began; later closes are the host's new sessions.
  const firstClose = new Map()
  for (const close of closes) {
    if (close.at < drainStartedAt || close.at > drainEndedAt || firstClose.has(close.host)) continue
    firstClose.set(close.host, close)
  }
  const grantsByHost = new Map()
  for (const grant of grants) {
    if (grant.at < drainStartedAt || grant.cellId === sourceCellId) continue
    grantsByHost.set(grant.host, [...(grantsByHost.get(grant.host) ?? []), grant])
  }
  const cutOffGapsMs = []
  const counts = { movedFirst: 0, cutOff: 0, cutOffUnresolved: 0, otherClose: 0 }
  const leftRegion = []
  let phoneSessionsDropped = 0
  for (const close of firstClose.values()) {
    phoneSessionsDropped += close.splices
    const hostGrants = grantsByHost.get(close.host) ?? []
    const first = hostGrants[0]
    if (first && first.at <= close.at) counts.movedFirst += 1
    else if (close.reason === DRAIN_CLOSE_REASON) {
      if (first) {
        counts.cutOff += 1
        cutOffGapsMs.push(first.at - close.at)
      } else counts.cutOffUnresolved += 1
    } else counts.otherClose += 1
    if (first && sourceRegion && cellRegions[first.cellId] && cellRegions[first.cellId] !== sourceRegion) {
      const back = hostGrants.find(
        (grant) => grant.at > first.at && cellRegions[grant.cellId] === sourceRegion
      )
      leftRegion.push(back ? back.at - first.at : null)
    }
  }
  const returned = leftRegion.filter((value) => value !== null)
  return {
    sourceCellId,
    controlsAtDrainStart,
    closedHosts: firstClose.size,
    // Below 1 means some drained desktops left no close line in the export; widen it.
    closeCoverage: controlsAtDrainStart > 0 ? firstClose.size / controlsAtDrainStart : null,
    ...counts,
    // Lower bound until the target cells run an image that logs control activation.
    cutOffGap: summary(cutOffGapsMs),
    phoneSessionsDropped,
    leftSourceRegion: leftRegion.length,
    leftSourceRegionStillAway: leftRegion.length - returned.length,
    timeUntilBack: summary(returned)
  }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(name) {
  const value = argument(name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

function main() {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const cellRegionsPath = argument('cell-regions')
  const result = measureDrainDisconnectGap({
    sourceCellId: required('source-cell'),
    drainStartedAt: Date.parse(required('drain-started-at')),
    drainEndedAt: Date.parse(required('drain-ended-at')),
    controlsAtDrainStart: Number(required('controls')),
    closes: readDrainCloses(readJson(required('cell-log'))),
    grants: readReconnectGrants(readJson(required('director-log'))),
    cellRegions: cellRegionsPath ? readJson(cellRegionsPath) : {}
  })
  console.log(JSON.stringify(result, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
