#!/usr/bin/env node
// Writes one cell's runtime switch object (cells/<cellId>.json in <project>-relay-control) and
// reads back what the cell applied. One cell per run by construction: the object is per cell.
//
// dry-run: checks the cell and the current generation, prints the change, writes nothing.
// write:   the same checks, then a compare-and-swap write (ifGenerationMatch), then waits for
//          the cell's runtime status to report the new generation applied.
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { fetchAdminOnceMore } from './relay-admin-transient-retry.mjs'

export const CELL_ID_PATTERN = /^(production|staging)-gce-c[0-9]{1,3}$/
export const WRITE_CONFIRMATION = 'WRITE_RELAY_CELL_FLAGS'
// The cell polls every 5 s (+20% jitter); 15 s leaves two polls of slack.
export const READ_BACK_TIMEOUT_MS = 15_000
const READ_BACK_INTERVAL_MS = 1_000
const STORAGE_ROOT = 'https://storage.googleapis.com'

// Every switch a cell image may know, with what an absent key means on the cell. A cell
// resets a key missing from its object to this default, so a write must carry every key it
// does not mean to change: the tool reads the current object and changes only what is named.
const enumOf = (...options) => (value) => (options.includes(value) ? value : undefined)
const booleanValue = (value) => (value === 'true' ? true : value === 'false' ? false : undefined)
const numberIn = (min, max, integer) => (value) => {
  const number = Number(value)
  if (value === '' || !Number.isFinite(number) || number < min || number > max) return undefined
  if (integer && !Number.isInteger(number)) return undefined
  return number
}
export const CELL_FLAG_SPECS = {
  readinessLocal: { parse: booleanValue, default: false },
  ticketCheck: { parse: enumOf('off', 'shadow', 'enforce'), default: 'off' },
  admitMode: { parse: enumOf('db', 'reserve'), default: 'db' },
  // Absent means the cell's region default.
  intakePerSec: {
    parse: (value) => {
      const rate = numberIn(0, 1_000, false)(value)
      return rate === 0 ? undefined : rate
    }
  },
  reserveDryRun: { parse: booleanValue, default: false },
  rejectionFence: { parse: booleanValue, default: true },
  // Absent keeps the cell's boot value.
  readTimeoutMarginMs: { parse: numberIn(1_000, 60_000, true) },
  // Flip-back leases in flight; absent is a third of the cell's pool.
  reregisterInFlight: { parse: numberIn(1, 16, true) }
}

export const RESERVE_CONFIRMATION = 'RESERVE'
export const BREAK_GLASS_CONFIRMATION = 'BREAK GLASS'
// Longer than a director's cached read of the admit-mode table (5 s).
export const RESERVE_MODE_CACHE_WAIT_MS = 10_000
// How long a flip back may take to lease every control the cell admitted from memory: its
// control count at a per-lane pace below the measured 0.38/s (170 ms trips), within the job.
export const REREGISTER_WAIT_MIN_MS = 8 * 60_000
export const REREGISTER_WAIT_MAX_MS = 50 * 60_000
const REREGISTER_CONTROLS_PER_LANE_PER_SEC = 0.3
// The cell takes a third of its database pool, and caps the switch at the pool less two
// (host-session-registry.ts reregisterInFlightLimit). An image from before runtime-status
// reported the pool falls back to the deployed sizes (US 10, Asia 16).
const CELL_DATABASE_POOL_MAX = { 'asia-east2': 16 }
const CELL_DATABASE_POOL_MAX_DEFAULT = 10

export function reregisterLanes(runtime) {
  const reported = runtime?.databasePoolMax
  const pool =
    Number.isInteger(reported) && reported > 0
      ? reported
      : (CELL_DATABASE_POOL_MAX[runtime?.region] ?? CELL_DATABASE_POOL_MAX_DEFAULT)
  const flag = runtime?.flagsApplied?.flags?.reregisterInFlight
  if (flag === undefined) return Math.max(1, Math.floor(pool / 3))
  return Math.max(1, Math.min(Number(flag), pool - 2))
}

export function reregisterWaitMs(runtime) {
  const controls = Number(runtime?.runtime?.controls ?? 0)
  const lanes = reregisterLanes(runtime)
  const estimate = (controls / (lanes * REREGISTER_CONTROLS_PER_LANE_PER_SEC)) * 1_000
  return Math.min(REREGISTER_WAIT_MAX_MS, Math.max(REREGISTER_WAIT_MIN_MS, Math.ceil(estimate)))
}

// An image from before `supportedFlags` accepts the keys its applied flags list, and only
// ticketCheck off/shadow: anything else is dropped there, or voids the whole object.
function legacySupportedFlags(appliedFlags) {
  return Object.fromEntries(
    Object.entries(appliedFlags ?? {}).map(([key, value]) => [
      key,
      key === 'ticketCheck'
        ? { type: 'enum', values: ['off', 'shadow'] }
        : { type: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'enum', values: [value] }
    ])
  )
}

function accepts(spec, value) {
  if (spec?.type === 'boolean') return typeof value === 'boolean'
  if (spec?.type === 'enum') return spec.values.includes(value)
  if (spec?.type === 'number') {
    return (
      typeof value === 'number' &&
      (spec.min === undefined || value >= spec.min) &&
      (spec.max === undefined || value <= spec.max) &&
      (!spec.integer || Number.isInteger(value))
    )
  }
  return false
}

// The whole object as it will be written, not only the change: a bad key or value already in
// the file would void or be dropped on every later write too.
export function assertSupportedObject(flags, runtime) {
  const supported = runtime.supportedFlags ?? legacySupportedFlags(runtime.flagsApplied?.flags)
  for (const [key, value] of Object.entries(flags)) {
    if (!accepts(supported[key], value)) {
      throw new Error(
        `the cell's image does not support ${key}=${JSON.stringify(value)}; roll the image first`
      )
    }
  }
}

// `key=value,key=value`; `key=default` removes the key so the cell uses its default.
export function parseFlagChanges(text) {
  const changes = {}
  for (const part of (text ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const separator = part.indexOf('=')
    const key = separator < 0 ? part : part.slice(0, separator)
    const raw = separator < 0 ? '' : part.slice(separator + 1).trim()
    const spec = CELL_FLAG_SPECS[key]
    if (!spec) throw new Error(`unknown switch ${key}`)
    if (key in changes) throw new Error(`switch ${key} named twice`)
    if (raw === 'default') {
      changes[key] = null
      continue
    }
    const value = spec.parse(raw)
    if (value === undefined) throw new Error(`switch ${key} cannot be ${JSON.stringify(raw)}`)
    changes[key] = value
  }
  if (Object.keys(changes).length === 0) throw new Error('set names no switch to change')
  return changes
}

// The switches as the cell will apply them: every known key, absent ones at their default.
function effectiveFlags(flags) {
  return Object.fromEntries(
    Object.entries(CELL_FLAG_SPECS).map(([key, spec]) => [key, flags?.[key] ?? spec.default])
  )
}

export function parseCellFlagsRequest(values) {
  const mode = values.mode
  if (mode !== 'dry-run' && mode !== 'write') throw new Error('mode must be dry-run or write')
  const cellId = values['cell-id'] ?? ''
  if (!CELL_ID_PATTERN.test(cellId)) throw new Error('cell id is not a relay GCE cell id')
  const changes = parseFlagChanges(values.set)
  // 0 means "no object yet": the write then creates it and refuses if one appeared.
  const expectedGeneration = values['expected-generation'] ?? ''
  if (!/^(0|[1-9][0-9]{0,18})$/.test(expectedGeneration)) {
    throw new Error('expected-generation must be 0 or the exact current object generation')
  }
  if (mode === 'write' && values.confirmation !== `${WRITE_CONFIRMATION} ${cellId}`) {
    throw new Error(`write requires the confirmation "${WRITE_CONFIRMATION} ${cellId}"`)
  }
  // Reserve moves this cell's hosts off the database: it is typed for this cell, every time.
  if (
    mode === 'write' &&
    changes.admitMode === 'reserve' &&
    values['confirm-reserve'] !== `${RESERVE_CONFIRMATION} ${cellId}`
  ) {
    throw new Error(`admitMode=reserve requires --confirm-reserve "${RESERVE_CONFIRMATION} ${cellId}"`)
  }
  // Break glass: a dead or unreachable reserve cell cannot report db, so nothing would ever
  // let the sweeps re-place its hosts. Only admitMode=db, typed for this cell.
  const breakGlass = values['break-glass'] ?? ''
  if (breakGlass !== '') {
    if (breakGlass !== `${BREAK_GLASS_CONFIRMATION} ${cellId}`) {
      throw new Error(`break glass requires --break-glass "${BREAK_GLASS_CONFIRMATION} ${cellId}"`)
    }
    if (mode !== 'write' || changes.admitMode !== null || Object.keys(changes).length !== 1) {
      throw new Error('break glass only writes admitMode=default (db), on its own')
    }
  }
  const directorOrigin = values['director-origin'] ?? ''
  if (changes.admitMode !== undefined && !/^https:\/\/relay(-staging)?\.onorca\.dev$/.test(directorOrigin)) {
    throw new Error('an admitMode change needs --director-origin, where Postgres records it')
  }
  const projectId = values['project-id'] ?? ''
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) throw new Error('project id is invalid')
  const cellOrigin = values['cell-origin'] ?? ''
  if (!/^https:\/\/c[0-9]{1,3}\.relay(-staging)?\.onorca\.dev$/.test(cellOrigin)) {
    throw new Error('cell origin is not a relay cell origin')
  }
  if (new URL(cellOrigin).hostname.split('.')[0] !== cellId.replace(/^[a-z]+-gce-/, '')) {
    throw new Error('cell origin names another cell')
  }
  return {
    mode,
    cellId,
    cellOrigin,
    directorOrigin,
    breakGlass: breakGlass !== '',
    projectId,
    expectedGeneration,
    changes
  }
}

// Read-modify-write: the current object's switches with only the named ones changed.
export function desiredObject(request, current) {
  if (current !== null && (current?.v !== 1 || current?.cellId !== request.cellId)) {
    throw new Error('the current object is not this cell\'s v1 switch object; fix it by hand')
  }
  const flags = { ...(current?.flags ?? {}) }
  for (const [key, value] of Object.entries(request.changes)) {
    if (value === null) delete flags[key]
    else flags[key] = value
  }
  return { v: 1, cellId: request.cellId, flags }
}

function objectUrl(request, suffix = '') {
  const bucket = `${request.projectId}-relay-control`
  return `${STORAGE_ROOT}/storage/v1/b/${bucket}/o/${encodeURIComponent(
    `cells/${request.cellId}.json`
  )}${suffix}`
}

// One transient 5xx or network failure is retried once, as every relay admin step does.
async function readRuntime(fetchImpl, request, idToken, wait) {
  const response = await fetchAdminOnceMore(
    fetchImpl,
    `${request.cellOrigin}/v1/admin/runtime-status`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1 })
    },
    { wait, timeoutMs: 10_000, retryDelayMs: 1_000 }
  )
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`cell runtime status returned ${response.status}`)
  }
  return await response.json()
}

async function readCurrentObject(fetchImpl, request, accessToken) {
  const headers = { authorization: `Bearer ${accessToken}` }
  const metadata = await fetchImpl(objectUrl(request), { headers })
  if (metadata.status === 404) {
    await metadata.body?.cancel().catch(() => undefined)
    return { generation: '0', object: null }
  }
  if (!metadata.ok) throw new Error(`object metadata read returned ${metadata.status}`)
  const { generation } = await metadata.json()
  const media = await fetchImpl(objectUrl(request, `?alt=media&ifGenerationMatch=${generation}`), {
    headers
  })
  if (!media.ok) throw new Error(`object read returned ${media.status}`)
  return { generation: String(generation), object: await media.json().catch(() => null) }
}

async function writeObject(fetchImpl, request, object, accessToken, audit) {
  const boundary = `relay-cell-flags-${Date.now()}`
  const metadata = {
    name: `cells/${request.cellId}.json`,
    contentType: 'application/json',
    cacheControl: 'no-store',
    // Who and which run, beside the generation the bucket's versioning already keeps.
    metadata: audit
  }
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    JSON.stringify(object),
    `--${boundary}--`,
    ''
  ].join('\r\n')
  const bucket = `${request.projectId}-relay-control`
  const response = await fetchImpl(
    `${STORAGE_ROOT}/upload/storage/v1/b/${bucket}/o?uploadType=multipart&ifGenerationMatch=${request.expectedGeneration}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  )
  // A 4xx means nothing was written; a 5xx or a lost reply may have been.
  if (response.status === 412) {
    await response.body?.cancel().catch(() => undefined)
    throw Object.assign(new Error('the object changed since expected-generation; re-read and retry'), {
      notWritten: true
    })
  }
  if (!response.ok) {
    throw Object.assign(new Error(`object write returned ${response.status}`), {
      notWritten: response.status < 500
    })
  }
  return String((await response.json()).generation)
}

// The census's record (relay_cell_admit_modes, through a director). Without `admitMode` it only
// reads. Read back on every write: sweeps act on this, not on the cell's switch file.
async function directorAdmitMode(fetchImpl, request, idToken, wait, admitMode) {
  const response = await fetchAdminOnceMore(
    fetchImpl,
    `${request.directorOrigin}/v1/admin/cell-admit-mode`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, cellId: request.cellId, ...(admitMode ? { admitMode } : {}) })
    },
    { wait, timeoutMs: 10_000, retryDelayMs: 1_000 }
  )
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`director refused admitMode: ${response.status} ${body?.error ?? ''}`)
  if (admitMode && body?.admitMode !== admitMode) {
    throw new Error(`director recorded admitMode ${body?.admitMode}, not ${admitMode}`)
  }
  return body
}

// Every known key, not just the ones this run changed: a cell that kept an old value of any
// switch has not applied this object. A key with no fixed default (the cell reports its own
// value) is compared only when the object names it.
export function sameFlags(applied, desired) {
  const expected = effectiveFlags(desired)
  const actual = effectiveFlags(applied)
  return Object.entries(CELL_FLAG_SPECS).every(
    ([key, spec]) =>
      (!('default' in spec) && desired?.[key] === undefined) || actual[key] === expected[key]
  )
}

// Sweeps resume only once every control the cell admitted from memory holds a lease again.
async function waitForLeasedControls(fetchImpl, request, idToken, { now, sleep, log }) {
  let waitMs
  let deadline = now() + REREGISTER_WAIT_MIN_MS
  while (now() < deadline) {
    const runtime = await readRuntime(fetchImpl, request, idToken, sleep).catch(() => null)
    // An image without the field never admitted from memory.
    if (runtime && (runtime.admitModeEffective ?? 'db') === 'db') return
    if (runtime && waitMs === undefined) {
      waitMs = reregisterWaitMs(runtime)
      deadline = now() + waitMs
      log(JSON.stringify({ event: 'orca_relay_cell_reregistration_wait', cellId: request.cellId, waitMs }))
    }
    await sleep(5_000)
  }
  log(JSON.stringify({ event: 'orca_relay_cell_reregistration_still_running', cellId: request.cellId }))
  throw new Error(
    `cell still re-registering after ${waitMs ?? REREGISTER_WAIT_MIN_MS} ms. Its connections are safe and Postgres ` +
      'keeps reserve, so sweeps stay off the cell. Run again with --set admitMode=db, which records db once ' +
      'runtime-status reports admitModeEffective=db; to speed it up, name both in one write: ' +
      '--set admitMode=db,reregisterInFlight=N'
  )
}

// No cell read-back and no wait for its controls: the cell is not answering. The file says db
// so a cell that comes back boots in db, and Postgres says db so the sweeps re-place its hosts.
async function breakGlassToDatabase(request, dependencies, { fetchImpl, log, sleep }) {
  const { accessToken, idToken, audit } = dependencies
  // Only for a dead cell: one that answers, or still heartbeats, takes the ordinary flip back.
  const answered = await fetchImpl(`${request.cellOrigin}/v1/admin/runtime-status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1 }),
    signal: AbortSignal.timeout(10_000)
  })
    .then(async (response) => {
      await response.body?.cancel().catch(() => undefined)
      return response.ok
    })
    .catch(() => false)
  if (answered) throw new Error('the cell answers runtime-status: flip it back with --set admitMode=db, not break glass')
  const recorded = await directorAdmitMode(fetchImpl, request, idToken, sleep)
  if (recorded?.heartbeatFresh !== false) {
    throw new Error(
      `the director ${recorded?.heartbeatFresh ? 'still sees heartbeats from' : 'cannot say whether it hears'} ` +
        'the cell: break glass is only for a cell that has stopped'
    )
  }
  const current = await readCurrentObject(fetchImpl, request, accessToken)
  if (current.generation !== request.expectedGeneration) {
    throw new Error(`current generation is ${current.generation}, not expected ${request.expectedGeneration}`)
  }
  const object = desiredObject(request, current.object)
  const generation = await writeObject(fetchImpl, request, object, accessToken, audit)
  await directorAdmitMode(fetchImpl, request, idToken, sleep, 'db')
  const result = { event: 'orca_relay_cell_admit_mode_break_glass', cellId: request.cellId, generation, audit }
  log(JSON.stringify(result))
  return { ...result, written: true }
}

export async function operateCellFlags(request, dependencies) {
  const { fetchImpl = fetch, accessToken, idToken, audit, log = console.log } = dependencies
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  if (request.breakGlass) return await breakGlassToDatabase(request, dependencies, { fetchImpl, log, sleep })
  const runtime = await readRuntime(fetchImpl, request, idToken, sleep)
  // Proves the origin is this cell, and that its image reads switch files at all.
  if (runtime.role !== 'cell' || runtime.cellId !== request.cellId) {
    throw new Error(`origin answers as ${runtime.role}/${runtime.cellId}, not ${request.cellId}`)
  }
  if (!runtime.flagsApplied) throw new Error('cell image has no flag channel (no flagsApplied)')
  const current = await readCurrentObject(fetchImpl, request, accessToken)
  const object = desiredObject(request, current.object)
  assertSupportedObject(object.flags, runtime)
  // A tripped dead-man: any new generation that keeps reserve re-arms it, so the cell trips
  // again and its re-registration restarts. Only a write that also says db is safe.
  if (
    runtime.flagsApplied.flags?.admitMode === 'reserve' &&
    runtime.admitModeEffective === 'db' &&
    (object.flags.admitMode ?? 'db') === 'reserve'
  ) {
    throw new Error(
      'the cell tripped its dead-man (reserve configured, db effective); a write that keeps reserve re-arms it. ' +
        'Name admitMode=db in the same write, e.g. --set admitMode=db,reregisterInFlight=N'
    )
  }
  const plan = {
    event: 'orca_relay_cell_flags_plan',
    mode: request.mode,
    cellId: request.cellId,
    currentGeneration: current.generation,
    currentObject: current.object,
    appliedBefore: runtime.flagsApplied,
    changes: request.changes,
    desired: object
  }
  // Before the generation check, so a dry run always shows the generation to pass next.
  log(JSON.stringify(plan))
  if (current.generation !== request.expectedGeneration) {
    throw new Error(
      `current generation is ${current.generation}, not expected ${request.expectedGeneration}`
    )
  }
  // The cell applies every readable write; a generation it did not apply was voided there. A
  // write of an object this image accepts whole (checked above) repairs it.
  if (current.generation !== '0' && String(runtime.flagsApplied.generation) !== current.generation) {
    log(
      JSON.stringify({
        event: 'orca_relay_cell_flags_repairing_unapplied_object',
        cellId: request.cellId,
        appliedGeneration: runtime.flagsApplied.generation,
        currentGeneration: current.generation
      })
    )
  }
  const admitModeChange =
    request.changes.admitMode === undefined ? undefined : (request.changes.admitMode ?? 'db')
  if (admitModeChange !== undefined) {
    const recorded = await directorAdmitMode(fetchImpl, request, idToken, sleep)
    log(JSON.stringify({ event: 'orca_relay_cell_admit_mode_recorded_before', ...recorded }))
  }
  if (request.mode === 'dry-run') return { ...plan, written: false }
  // Sweeps skip the cell before it starts admitting from memory, never after.
  let generation
  if (admitModeChange === 'reserve') {
    const before = await directorAdmitMode(fetchImpl, request, idToken, sleep)
    await directorAdmitMode(fetchImpl, request, idToken, sleep, 'reserve')
    // Every director's cached set expires (5 s) before the cell starts admitting from memory;
    // the second write re-runs the open-flow check over anything started meanwhile.
    await sleep(RESERVE_MODE_CACHE_WAIT_MS)
    try {
      await directorAdmitMode(fetchImpl, request, idToken, sleep, 'reserve')
    } catch (error) {
      // A drain, migration or rehome opened during the wait: Postgres goes back as it was.
      if (before?.admitMode === 'db') await directorAdmitMode(fetchImpl, request, idToken, sleep, 'db')
      throw error
    }
    try {
      generation = await writeObject(fetchImpl, request, object, accessToken, audit)
    } catch (error) {
      // The file was refused outright (412, 4xx): put Postgres back as it was. After a 5xx the
      // object may be written, so Postgres keeps reserve (sweeps stay off: the safe side).
      if (error?.notWritten && before?.admitMode === 'db') {
        await directorAdmitMode(fetchImpl, request, idToken, sleep, 'db')
      }
      throw error
    }
  } else {
    generation = await writeObject(fetchImpl, request, object, accessToken, audit)
  }
  log(JSON.stringify({ event: 'orca_relay_cell_flags_written', cellId: request.cellId, generation }))
  const deadline = now() + READ_BACK_TIMEOUT_MS
  let last = runtime.flagsApplied
  while (now() < deadline) {
    await sleep(READ_BACK_INTERVAL_MS)
    try {
      last = (await readRuntime(fetchImpl, request, idToken, sleep)).flagsApplied
    } catch {
      // The object is written; a failed poll only delays the read-back until the deadline.
      continue
    }
    if (String(last?.generation) !== generation) continue
    // The image predates a switch this object names: it applied the rest and dropped that one.
    if (Array.isArray(last.ignoredKeys) && last.ignoredKeys.length > 0) {
      throw new Error(
        `cell applied generation ${generation} but ignores ${last.ignoredKeys.join(', ')}; ` +
          'its image predates them, so flip the object back'
      )
    }
    if (sameFlags(last.flags, object.flags)) {
      const result = { ...plan, written: true, generation, applied: last }
      log(JSON.stringify({ ...result, event: 'orca_relay_cell_flags_applied_read_back' }))
      if (admitModeChange === 'db') {
        await waitForLeasedControls(fetchImpl, request, idToken, { now, sleep, log })
        await directorAdmitMode(fetchImpl, request, idToken, sleep, 'db')
        log(JSON.stringify({ event: 'orca_relay_cell_admit_mode_recorded', cellId: request.cellId, admitMode: 'db' }))
      }
      return result
    }
  }
  throw new Error(
    `cell did not apply generation ${generation} within ${READ_BACK_TIMEOUT_MS} ms ` +
      `(last applied ${JSON.stringify(last)}); the object is written`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: Object.fromEntries(
      [
        'mode',
        'cell-id',
        'cell-origin',
        'project-id',
        'set',
        'expected-generation',
        'confirmation',
        'confirm-reserve',
        'break-glass',
        'director-origin'
      ].map((name) => [name, { type: 'string' }])
    )
  })
  try {
    const request = parseCellFlagsRequest(values)
    const accessToken = process.env.ORCA_RELAY_CONTROL_ACCESS_TOKEN
    const idToken = process.env.ORCA_RELAY_ADMIN_ID_TOKEN
    if (!accessToken || !idToken) throw new Error('both tokens are required')
    await operateCellFlags(request, {
      accessToken,
      idToken,
      audit: {
        // The person who started this attempt, which differs from GITHUB_ACTOR on a re-run.
        writtenBy: process.env.GITHUB_TRIGGERING_ACTOR ?? process.env.GITHUB_ACTOR ?? 'unknown',
        runId: process.env.GITHUB_RUN_ID ?? 'local',
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '0'
      }
    })
  } catch (error) {
    // On stdout, so the job summary's copy of the run carries the reason.
    console.log(
      JSON.stringify({
        event: 'orca_relay_cell_flags_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    process.exitCode = 1
  }
}
