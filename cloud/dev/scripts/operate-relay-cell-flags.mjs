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

export function parseCellFlagsRequest(values) {
  const mode = values.mode
  if (mode !== 'dry-run' && mode !== 'write') throw new Error('mode must be dry-run or write')
  const cellId = values['cell-id'] ?? ''
  if (!CELL_ID_PATTERN.test(cellId)) throw new Error('cell id is not a relay GCE cell id')
  if (values['readiness-local'] !== 'true' && values['readiness-local'] !== 'false') {
    throw new Error('readiness-local must be true or false')
  }
  const ticketCheck = values['ticket-check']
  if (ticketCheck !== 'off' && ticketCheck !== 'shadow') {
    throw new Error('ticket-check must be off or shadow')
  }
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
    object: {
      v: 1,
      cellId,
      flags: { readinessLocal: values['readiness-local'] === 'true', ticketCheck }
    }
  }
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

async function writeObject(fetchImpl, request, accessToken, audit) {
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
    JSON.stringify(request.object),
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

const sameFlags = (left, right) =>
  left?.readinessLocal === right.readinessLocal && left?.ticketCheck === right.ticketCheck

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
  const current = await readCurrentObject(fetchImpl, request, accessToken)
  const plan = {
    event: 'orca_relay_cell_flags_plan',
    mode: request.mode,
    cellId: request.cellId,
    currentGeneration: current.generation,
    currentObject: current.object,
    appliedBefore: runtime.flagsApplied,
    desired: request.object
  }
  // Before the generation check, so a dry run always shows the generation to pass next.
  log(JSON.stringify(plan))
  if (current.generation !== request.expectedGeneration) {
    throw new Error(
      `current generation is ${current.generation}, not expected ${request.expectedGeneration}`
    )
  }
  if (request.mode === 'dry-run') return { ...plan, written: false }
  const generation = await writeObject(fetchImpl, request, accessToken, audit)
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
    if (String(last?.generation) === generation && sameFlags(last.flags, request.object.flags)) {
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
        'readiness-local',
        'ticket-check',
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
