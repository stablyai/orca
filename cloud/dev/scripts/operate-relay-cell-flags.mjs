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
  readTimeoutMarginMs: { parse: numberIn(1_000, 60_000, true) }
}

// What images from before `supportedFlags` accept; anything else voids or is dropped there.
const LEGACY_SUPPORTED_FLAGS = {
  readinessLocal: { type: 'boolean' },
  ticketCheck: { type: 'enum', values: ['off', 'shadow'] }
}

// Refuses a change the cell's image would drop (unknown key) or void the whole object over
// (a value outside what it accepts). Removing a key is always safe.
export function assertSupportedChanges(changes, supportedFlags) {
  const supported = supportedFlags ?? LEGACY_SUPPORTED_FLAGS
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) continue
    const spec = supported[key]
    const accepted =
      spec?.type === 'boolean'
        ? typeof value === 'boolean'
        : spec?.type === 'enum'
          ? spec.values.includes(value)
          : spec?.type === 'number'
            ? typeof value === 'number' &&
              (spec.min === undefined || value >= spec.min) &&
              (spec.max === undefined || value <= spec.max) &&
              (!spec.integer || Number.isInteger(value))
            : false
    if (!accepted) {
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
  if (response.status === 412) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('the object changed since expected-generation; re-read and retry')
  }
  if (!response.ok) throw new Error(`object write returned ${response.status}`)
  return String((await response.json()).generation)
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

export async function operateCellFlags(request, dependencies) {
  const { fetchImpl = fetch, accessToken, idToken, audit, log = console.log } = dependencies
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const runtime = await readRuntime(fetchImpl, request, idToken, sleep)
  // Proves the origin is this cell, and that its image reads switch files at all.
  if (runtime.role !== 'cell' || runtime.cellId !== request.cellId) {
    throw new Error(`origin answers as ${runtime.role}/${runtime.cellId}, not ${request.cellId}`)
  }
  if (!runtime.flagsApplied) throw new Error('cell image has no flag channel (no flagsApplied)')
  assertSupportedChanges(request.changes, runtime.supportedFlags)
  const current = await readCurrentObject(fetchImpl, request, accessToken)
  const object = desiredObject(request, current.object)
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
  if (request.mode === 'dry-run') return { ...plan, written: false }
  const generation = await writeObject(fetchImpl, request, object, accessToken, audit)
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
        'confirmation'
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
