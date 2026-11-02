#!/usr/bin/env node
// Watches one cell already in reserve mode and, on the first stop rule it trips, flips it back to
// db through the flag tool's own write (CAS, read-back, re-registration wait). Step 5 design §9.
//
// watch:     one segment of the watch (the workflow re-authenticates between segments, since an
//            ID token lasts an hour). State carries over in --state-file. Writes nothing.
// outcome:   the job's state and verdict, from the state file.
// flip-back: the flag tool's admitMode=db write (or its dry run), then exits non-zero with the
//            watch's verdict. Why it holds no flag-workflow group: docs/relay-workflows.md.
// alarm:     a refused watch or a flip back that did not land: an error annotation, and in write
//            mode a log line the reserve-watch alert pages on.
import { execFile } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  BREAK_GLASS_CONFIRMATION,
  operateCellFlags,
  parseCellFlagsRequest,
  readCurrentObject,
  readRuntime,
  WRITE_CONFIRMATION
} from './operate-relay-cell-flags.mjs'
import { readDirectorRequestsByCodePerMinute, readLogEntries } from './relay-same-cap-shadow-gate.mjs'
import { minutesOf } from './relay-same-cap-shadow-gate-verdict.mjs'
import { PRODUCTION_LEASE } from './cloud-sql-rollout-lock-census.mjs'
import { RELAY_REPOSITORY_ROOT } from './relay-repository.mjs'
import {
  evaluateWatchSample,
  initialWatchState,
  measuredBackground,
  RESERVE_WATCH_RULES
} from './relay-reserve-watch-rules.mjs'

const execFileAsync = promisify(execFile)
const MINUTE_MS = 60_000
export const SAMPLE_INTERVAL_MS = MINUTE_MS
export const MAX_WATCH_MINUTES = 300
// Below the hour an ID token lasts, with room for the segment's last sample.
export const MAX_SEGMENT_MINUTES = 55
const METRIC_DELAY_MS = RESERVE_WATCH_RULES.director503.publishDelayMs
const BACKGROUND_MINUTES = 10
// A flipped-at older than this is a typo or a stale dispatch, not this flip.
const MAX_FLIPPED_AT_AGE_MS = 24 * 60 * MINUTE_MS
export const FLIP_BACK_ATTEMPTS = 5
const FLIP_BACK_BACKOFF_MS = 2_000
// One slow runtime-status reply is not a dead cell: retried this often before break glass.
export const FLIP_BACK_RUNTIME_ATTEMPTS = 4
const SAMPLE_READ_BUDGET_MS = 40_000
const LOG_ENTRY_LIMIT = 1_000

function integerIn(name, raw, min, max) {
  const value = Number(raw)
  if (!/^[0-9]+$/.test(raw ?? '') || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

// The flip back's request. Its generation is a placeholder: the flip back re-reads the current one.
export function dbFlipRequest(values) {
  return parseCellFlagsRequest({ ...values, set: 'admitMode=db', 'expected-generation': '0' })
}

// `now` is the watch's start: a later segment of a long watch must not age flipped-at out.
function parseFlippedAt(raw, now) {
  if (raw === '') return null
  const at = Date.parse(raw)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(at)) {
    throw new Error('--flipped-at must be an ISO time with a zone, e.g. 2026-10-14T12:00:00Z')
  }
  if (at > now) throw new Error('--flipped-at is in the future')
  if (at < now - MAX_FLIPPED_AT_AGE_MS) throw new Error('--flipped-at is more than 24 hours ago')
  return at
}

export function parseWatchArguments(values, now = Date.now()) {
  // The flag tool's own checks, so the watch is of exactly the cell the flip back would write;
  // a write-mode watch refuses a missing confirmation now, not hours later.
  const request = dbFlipRequest(values)
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(values['director-service'] ?? '')) {
    throw new Error('--director-service is not a Cloud Run service name')
  }
  const background = values['background-503-per-minute'] ?? ''
  if (background !== '' && !/^(0|[1-9][0-9]{0,6})(\.[0-9]+)?$/.test(background)) {
    throw new Error('--background-503-per-minute must be empty (measure it) or a non-negative number')
  }
  // The background must predate the flip: a watch starts after it, so its own past is not one.
  const flippedAt = parseFlippedAt(values['flipped-at'] ?? '', now)
  if (background === '' && flippedAt === null) {
    throw new Error('--flipped-at (the background is the 10 minutes before it) or --background-503-per-minute is required')
  }
  if (!values['state-file']) throw new Error('--state-file is required')
  return {
    request,
    directorService: values['director-service'],
    durationMinutes: integerIn('duration-minutes', values['duration-minutes'], 5, MAX_WATCH_MINUTES),
    segmentMinutes: integerIn('segment-minutes', values['segment-minutes'], 1, MAX_SEGMENT_MINUTES),
    unverifiableLimit: integerIn('unverifiable-limit', values['unverifiable-limit'], 1, 30),
    background503PerMinute: background === '' ? null : Number(background),
    flippedAt,
    stateFile: values['state-file'],
    githubOutput: values['github-output'] || null
  }
}

const failedRead = (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

export async function readCellSample(fetchImpl, request, idToken, wait) {
  try {
    const runtime = await readRuntime(fetchImpl, request, idToken, wait)
    if (runtime.role !== 'cell' || runtime.cellId !== request.cellId) {
      return failedRead(`origin answers as ${runtime.role}/${runtime.cellId}`)
    }
    if (!runtime.flagsApplied) return failedRead('runtime-status reports no flagsApplied')
    const controls = runtime.runtime?.controls
    if (!Number.isInteger(controls)) return failedRead('runtime-status reports no control count')
    return {
      ok: true,
      admitModeConfigured: runtime.flagsApplied.flags?.admitMode ?? 'db',
      admitModeEffective: runtime.admitModeEffective,
      draining: runtime.draining === true,
      controls,
      enforcedUnits: runtime.runtime?.enforcedConnectionUnits,
      hardCap: runtime.connectionCapacity?.hardCap
    }
  } catch (error) {
    return failedRead(error)
  }
}

const minuteFloor = (at) => Math.floor(at / MINUTE_MS) * MINUTE_MS
const failed503Read = (error) => ({ ok: false, error, perMinute: {}, minutes: [], publishedThrough: null })

// The `minutes` whole minutes that end at the minute boundary `endedAt`: the 503 counts, and the
// newest minute any response code has a point for. The director always serves something, so that
// front is how far the 503 series is published; no front at all is no evidence. A code publishing
// late only delays a trip: a later read sees its points.
export async function readDirector503Minutes(reader, { projectId, directorService, endedAt, minutes }) {
  const span = { startedAt: new Date(endedAt - minutes * MINUTE_MS), endedAt: new Date(endedAt) }
  let read
  try {
    read = await readDirectorRequestsByCodePerMinute(reader, { config: { projectId, directorService }, span })
  } catch (error) {
    // A point with an unparseable end time has no minute.
    return failed503Read(`director 503 metric unreadable: ${error instanceof Error ? error.message : error}`)
  }
  if (read.failed) return failed503Read('director 503 metric read failed')
  const published = Object.values(read.byCode).flatMap((perMinute) => Object.keys(perMinute)).sort()
  return {
    ok: true,
    perMinute: read.byCode['503'] ?? {},
    minutes: minutesOf(span),
    publishedThrough: published.at(-1) ?? null
  }
}

const LEDGER_SUMMARY_EVENT = 'orca_relay_reserve_ledger_summary'
const SEAT_BEHIND_ROW_EVENT = 'orca_relay_reserve_ledger_seat_behind_row'

function directorLogFilter(directorService, eventClause, sinceAt) {
  return [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${directorService}"`,
    eventClause,
    `timestamp>="${new Date(sinceAt).toISOString()}"`
  ].join(' AND ')
}

// Newest summary per director instance; queued plus dropped rows are the ones not in Postgres.
export async function readLedgerSample(reader, { directorService, at }) {
  const read = await readLogEntries(reader, {
    filter: directorLogFilter(directorService, `jsonPayload.event="${LEDGER_SUMMARY_EVENT}"`, at - RESERVE_WATCH_RULES.ledgerSummaryMaxAgeMs),
    projection: 'json(timestamp,labels.instanceId,jsonPayload.pending,jsonPayload.dropped)',
    limit: LOG_ENTRY_LIMIT
  })
  if (read.failed) return failedRead(read.error)
  if (read.entries.length >= LOG_ENTRY_LIMIT) return failedRead('ledger summary read truncated')
  if (read.entries.length === 0) return failedRead('no placing director logged a ledger summary')
  if (read.entries.some((entry) => !Number.isFinite(Date.parse(entry.timestamp)))) {
    return failedRead('ledger summary with an unparseable timestamp')
  }
  const newest = new Map()
  for (const entry of read.entries) {
    const instance = entry.labels?.instanceId ?? 'unknown'
    const previous = newest.get(instance)
    if (!previous || Date.parse(entry.timestamp) > Date.parse(previous.timestamp)) newest.set(instance, entry)
  }
  let unwrittenRows = 0
  for (const entry of newest.values()) {
    const pending = Number(entry.jsonPayload?.pending)
    const dropped = Number(entry.jsonPayload?.dropped)
    if (!Number.isFinite(pending) || !Number.isFinite(dropped)) return failedRead('ledger summary without counts')
    unwrittenRows += pending + dropped
  }
  return { ok: true, unwrittenRows, directors: newest.size }
}

// The same read also takes the ledger summary every placing director logs each minute, as a
// positive control: with no fresh summary in it, no seat-behind-row line is blindness, not zero.
export async function readSeatBehindRowSample(reader, { directorService, cellId, at }) {
  const read = await readLogEntries(reader, {
    filter: directorLogFilter(
      directorService,
      `((jsonPayload.event="${SEAT_BEHIND_ROW_EVENT}" AND jsonPayload.cellId="${cellId}") OR jsonPayload.event="${LEDGER_SUMMARY_EVENT}")`,
      at - RESERVE_WATCH_RULES.duplicateSeat.lookbackMs
    ),
    projection: 'json(timestamp,labels.instanceId,jsonPayload.event,jsonPayload.epoch,jsonPayload.rowEpoch)',
    limit: LOG_ENTRY_LIMIT
  })
  if (read.failed) return failedRead(read.error)
  if (read.entries.length >= LOG_ENTRY_LIMIT) return failedRead('seat-behind-row read truncated')
  const reports = []
  let controlSeen = false
  for (const entry of read.entries) {
    const reportedAt = Date.parse(entry.timestamp)
    if (!Number.isFinite(reportedAt)) return failedRead('seat-behind-row line with an unparseable timestamp')
    if (entry.jsonPayload?.event === LEDGER_SUMMARY_EVENT) {
      controlSeen ||= reportedAt >= at - RESERVE_WATCH_RULES.ledgerSummaryMaxAgeMs
      continue
    }
    const { epoch, rowEpoch } = entry.jsonPayload ?? {}
    if (epoch === undefined || rowEpoch === undefined) return failedRead('seat-behind-row line without epochs')
    // Everything the line carries but its time, which differs on every report of one seat. A
    // proxy for the host: two hosts sharing it read as one seat, so it can only over-count.
    reports.push({ at: reportedAt, key: `${entry.labels?.instanceId ?? 'unknown'}/${cellId}/${epoch}:${rowEpoch}` })
  }
  if (!controlSeen) return failedRead('seat-behind-row read holds no fresh ledger summary (positive control)')
  return { ok: true, reports }
}

function createReader(dependencies, projectId) {
  const now = dependencies.now
  return {
    runGcloud: dependencies.runGcloud,
    fetch: dependencies.fetchImpl,
    retryDelayMs: dependencies.retryDelayMs ?? 5_000,
    readTimeoutMs: 20_000,
    now,
    // Every sample gets its own budget, so a slow read costs one sample, not the watch.
    deadlineAt: now() + SAMPLE_READ_BUDGET_MS,
    projectId
  }
}

/**
 * Same-cap and capacity rolls hold the Cloud SQL rollout lease for the whole run; it names no
 * cell, so any live holder refuses the watch's start. Read only: holding it for hours would block
 * every rollout. An unreadable lease refuses too (fail closed, as the lease action does).
 */
export async function rolloutLeaseRefusal(readRolloutLease, now) {
  try {
    const existing = await readRolloutLease()
    if (!existing || existing.record.expires_at <= now) return null
    return (
      `a rollout holds the Cloud SQL rollout lease until ${new Date(existing.record.expires_at).toISOString()} ` +
      `(${existing.holder}); start the watch after it ends`
    )
  } catch (error) {
    return `the Cloud SQL rollout lease is unreadable (${error instanceof Error ? error.message : error}); refusing to start`
  }
}

// The lease action's own reader, resolved from the repository root because this tree's depth
// differs between the two repositories' copies.
async function readProductionRolloutLease() {
  const action = new URL('.github/actions/cloud-sql-rollout-lease/', RELAY_REPOSITORY_ROOT)
  const [{ CloudSqlRolloutLease, describeHolder }, { createAccessTokenSource }] = await Promise.all([
    import(new URL('storage-lease.mjs', action).href),
    import(new URL('gcloud-access-token.mjs', action).href)
  ])
  const lease = new CloudSqlRolloutLease({
    bucket: PRODUCTION_LEASE.bucket,
    objectName: PRODUCTION_LEASE.object,
    accessToken: createAccessTokenSource()
  })
  const existing = await lease.read()
  return existing && { record: existing.record, holder: describeHolder(existing.record) }
}

// Only a missing file is a fresh watch. Anything else that is not a state fails the segment, which
// the outcome step reads as failed and flips back: a corrupt file must not restart or refuse the watch.
export async function loadState(path) {
  const text = await readFile(path, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  if (text === null) return null
  const state = JSON.parse(text)
  const isObject = state !== null && typeof state === 'object' && !Array.isArray(state)
  if (!isObject || typeof state.state !== 'string') throw new Error(`state file ${path} holds no watch state`)
  if (state.state === 'watching' && (typeof state.cellId !== 'string' || !Number.isFinite(state.startedAt))) {
    throw new Error(`state file ${path} has no cell or start`)
  }
  return state
}

// A segment's config. Later segments check flipped-at against the watch's start; bad inputs before
// the first sample are refused, so no flip back follows a typo.
export async function parseWatchSegment(values, now = Date.now()) {
  const existing = values['state-file'] ? await loadState(values['state-file']) : null
  try {
    return parseWatchArguments(values, Number.isFinite(existing?.startedAt) ? existing.startedAt : now)
  } catch (error) {
    if (values['state-file'] && existing === null) {
      await writeFile(values['state-file'], JSON.stringify({ state: 'refused', verdict: error.message }))
    }
    throw error
  }
}

export async function watchSegment(config, dependencies) {
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = dependencies.log ?? console.log
  const deps = { ...dependencies, now, sleep, fetchImpl: dependencies.fetchImpl ?? fetch }
  const { request, directorService } = config
  let state = await loadState(config.stateFile)
  if (state === null) {
    const refusal = await rolloutLeaseRefusal(dependencies.readRolloutLease, now())
    if (refusal) {
      state = { state: 'refused', verdict: refusal }
      await writeFile(config.stateFile, JSON.stringify(state))
      if (config.githubOutput) await writeOutcome(config.githubOutput, state)
      return state
    }
    state = initialWatchState({
      cellId: request.cellId,
      startedAt: now(),
      durationMinutes: config.durationMinutes,
      background503PerMinute: config.background503PerMinute,
      flippedAt: config.flippedAt
    })
  }
  if (state.cellId !== request.cellId) throw new Error(`state file is for ${state.cellId}, not ${request.cellId}`)
  const segmentEndsAt = now() + config.segmentMinutes * MINUTE_MS
  while (state.state === 'watching' && now() < segmentEndsAt) {
    const at = now()
    const baselineEndsAt = state.flippedAt === null ? null : minuteFloor(state.flippedAt)
    if (!state.background && baselineEndsAt !== null && at >= baselineEndsAt + METRIC_DELAY_MS) {
      // The minutes just before the flip, once published; retried every sample until one reads.
      const read = await readDirector503Minutes(createReader(deps, request.projectId), {
        projectId: request.projectId,
        directorService,
        endedAt: baselineEndsAt,
        minutes: BACKGROUND_MINUTES
      })
      state = { ...state, background: read.ok ? measuredBackground(read.perMinute, read.minutes, read.publishedThrough) : null }
    }
    const reader = createReader(deps, request.projectId)
    // Serialised: concurrent Logging reads are what earn a 429.
    const sample = {
      at,
      cell: await readCellSample(deps.fetchImpl, request, dependencies.idToken, sleep),
      director503: await readDirector503Minutes(reader, {
        projectId: request.projectId,
        directorService,
        // Complete minutes only, held back past the publishing delay.
        endedAt: minuteFloor(at - METRIC_DELAY_MS),
        minutes: RESERVE_WATCH_RULES.director503.readMinutes
      }),
      ledger: await readLedgerSample(reader, { directorService, at }),
      seatBehindRow: await readSeatBehindRowSample(reader, { directorService, cellId: request.cellId, at })
    }
    const result = evaluateWatchSample(state, sample, { unverifiableLimit: config.unverifiableLimit })
    state = result.state
    log(result.line)
    await writeFile(config.stateFile, JSON.stringify(state))
    if (state.state !== 'watching') break
    await sleep(Math.max(0, at + SAMPLE_INTERVAL_MS - now()))
  }
  if (config.githubOutput) await writeOutcome(config.githubOutput, state)
  return state
}

function writeOutcome(githubOutput, { state, verdict }) {
  return appendFile(githubOutput, `state=${state}\nverdict=${(verdict ?? '').replace(/[\r\n]+/g, ' ')}\n`)
}

// The job's outcome. A watch that ended mid-segment (a crash, a timeout) records failed, which the
// workflow flips back in write mode: missing data is never healthy.
export async function recordOutcome(stateFile, githubOutput) {
  const state = await loadState(stateFile).catch(() => null)
  const outcome =
    state && state.state !== 'watching' ? state : { state: 'failed', verdict: 'the watch stopped before a verdict' }
  await writeOutcome(githubOutput, outcome)
  return outcome
}

function breakGlassInputs(request, generation) {
  return {
    mode: 'write',
    'cell-id': request.cellId,
    set: 'admitMode=default',
    'break-glass': `${BREAK_GLASS_CONFIRMATION} ${request.cellId}`,
    'expected-generation': generation,
    confirmation: `${WRITE_CONFIRMATION} ${request.cellId}`
  }
}

async function readRuntimeRetrying(fetchImpl, request, idToken, sleep, log) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readRuntime(fetchImpl, request, idToken, sleep)
    } catch (error) {
      if (attempt >= FLIP_BACK_RUNTIME_ATTEMPTS) throw error
      log(JSON.stringify({ event: 'orca_relay_reserve_watch_runtime_retry', cellId: request.cellId, attempt, message: error instanceof Error ? error.message : String(error) }))
      await sleep(FLIP_BACK_BACKOFF_MS * 2 ** (attempt - 1))
    }
  }
}

/**
 * The flag tool's admitMode=db write at the generation read just now. A generation conflict (some
 * other write landed first) is re-read and retried while the switch file still says reserve; a
 * file that already says db is done. A cell that still does not answer after the runtime retries
 * needs break glass, which only an operator may type.
 */
export async function flipBack(values, dependencies) {
  const log = dependencies.log ?? console.log
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const base = dbFlipRequest(values)
  const record = (result) =>
    log(
      JSON.stringify({
        event: 'orca_relay_reserve_watch_flip_back',
        mode: base.mode,
        cellId: base.cellId,
        written: result.written,
        generation: result.generation ?? null,
        ...(result.alreadyDb ? { alreadyDb: true } : {})
      })
    )
  for (let attempt = 1; ; attempt += 1) {
    const current = await readCurrentObject(fetchImpl, base, dependencies.accessToken)
    if ((current.object?.flags?.admitMode ?? 'db') !== 'reserve') {
      const result = { written: false, alreadyDb: true, generation: current.generation }
      record(result)
      return result
    }
    try {
      await readRuntimeRetrying(fetchImpl, base, dependencies.idToken, sleep, log)
    } catch (error) {
      const inputs = breakGlassInputs(base, current.generation)
      log(JSON.stringify({ event: 'orca_relay_reserve_watch_break_glass_required', cellId: base.cellId, inputs }))
      throw new Error(
        `${base.cellId} does not answer runtime-status (${error instanceof Error ? error.message : error}), so ` +
          'the flag tool cannot flip it back. Run Operate Relay Production Cell Flags with break glass: ' +
          Object.entries(inputs).map(([key, value]) => `${key}=${value}`).join(', ')
      )
    }
    try {
      const result = await operateCellFlags(
        { ...base, expectedGeneration: current.generation },
        { ...dependencies, fetchImpl, log, sleep }
      )
      record(result)
      return result
    } catch (error) {
      if (!error?.generationConflict || attempt >= FLIP_BACK_ATTEMPTS) throw error
      log(JSON.stringify({ event: 'orca_relay_reserve_watch_flip_back_conflict', cellId: base.cellId, attempt, message: error.message }))
      await sleep(FLIP_BACK_BACKOFF_MS * 2 ** (attempt - 1))
    }
  }
}

export const ALARM_EVENT = 'orca_relay_reserve_watch_alarm'
export const ALARM_LOG_NAME = 'orca-relay-reserve-watch'
export const ALARM_KINDS = ['refused', 'flip-back-failed']

// GitHub's workflow-command escaping, so a verdict cannot end the annotation or start another.
export const escapeWorkflowCommand = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
const escapeWorkflowProperty = (text) => escapeWorkflowCommand(text).replace(/:/g, '%3A').replace(/,/g, '%2C')

/**
 * Both kinds can leave the cell in reserve with nothing watching it. Only write mode pages: a
 * dry-run watch never flips back, so its refusal or failure changes nothing for the cell.
 */
export async function raiseAlarm({ mode, cellId, projectId, kind, reason }, { runGcloud, log = console.log }) {
  if (!ALARM_KINDS.includes(kind)) throw new Error(`--kind must be one of ${ALARM_KINDS.join(', ')}`)
  const message =
    kind === 'refused'
      ? `${cellId} may be in reserve mode and unwatched: the watch was refused (${reason}). Rerun it, or flip the cell to db with Operate Relay Production Cell Flags.`
      : `${cellId} may still be in reserve mode with no watch: the flip back did not land (${reason}). Flip it to db by hand with Operate Relay Production Cell Flags (set=admitMode=db), or with the break-glass inputs logged above if the cell does not answer.`
  log(`::error title=${escapeWorkflowProperty(`Reserve watch ${kind} for ${cellId}`)}::${escapeWorkflowCommand(message)}`)
  if (mode !== 'write') return { paged: false }
  const entry = JSON.stringify({ event: ALARM_EVENT, cellId, kind, reason })
  try {
    // The flag tool's project check: a missing --project-id must not reach gcloud as "undefined".
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId ?? '')) throw new Error('--project-id is not a GCP project id')
    await runGcloud(
      ['logging', 'write', ALARM_LOG_NAME, entry, '--payload-type=json', '--severity=ERROR', '--project', projectId],
      { timeoutMs: 30_000 }
    )
  } catch (error) {
    log(`::error title=Reserve watch page failed::${escapeWorkflowCommand(`the alarm log line was not written, so nothing pages: ${error instanceof Error ? error.message : error}`)}`)
    return { paged: false }
  }
  return { paged: true }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(
      [
        'mode',
        'cell-id',
        'cell-origin',
        'project-id',
        'director-origin',
        'director-service',
        'confirmation',
        'duration-minutes',
        'segment-minutes',
        'unverifiable-limit',
        'background-503-per-minute',
        'flipped-at',
        'state-file',
        'github-output',
        'verdict',
        'kind'
      ].map((name) => [name, { type: 'string' }])
    )
  })
  const idToken = process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  const runGcloud = (args, { timeoutMs }) =>
    execFileAsync('gcloud', args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' })
  try {
    if (command === 'alarm') {
      await raiseAlarm(
        { mode: values.mode, cellId: values['cell-id'] ?? '', projectId: values['project-id'], kind: values.kind, reason: values.verdict ?? '' },
        { runGcloud }
      )
      // The alarm step is red, whatever the page did.
      process.exitCode = 1
    } else if (command === 'outcome') {
      if (!values['state-file'] || !values['github-output']) throw new Error('--state-file and --github-output are required')
      console.log(JSON.stringify({ event: 'orca_relay_reserve_watch_outcome', ...(await recordOutcome(values['state-file'], values['github-output'])) }))
    } else if (!idToken) {
      throw new Error('ORCA_RELAY_ADMIN_ID_TOKEN is required')
    } else if (command === 'watch') {
      const config = await parseWatchSegment(values)
      const state = await watchSegment(config, {
        idToken,
        readRolloutLease: readProductionRolloutLease,
        runGcloud
      })
      // A cell that was never reserve is the operator's mistake; one flipped back by hand is not.
      if (state.state === 'refused') {
        console.log(JSON.stringify({ event: 'orca_relay_reserve_watch_refused', verdict: state.verdict }))
        process.exitCode = 1
      }
    } else if (command === 'flip-back') {
      const accessToken = process.env.ORCA_RELAY_CONTROL_ACCESS_TOKEN
      if (!accessToken) throw new Error('ORCA_RELAY_CONTROL_ACCESS_TOKEN is required')
      if (!values.verdict) throw new Error('--verdict is required')
      await flipBack(values, {
        accessToken,
        idToken,
        audit: {
          writtenBy: `reserve-watch/${process.env.GITHUB_TRIGGERING_ACTOR ?? process.env.GITHUB_ACTOR ?? 'unknown'}`,
          runId: process.env.GITHUB_RUN_ID ?? 'local',
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '0'
        }
      })
      // A trip is a failed watch even once the cell is safely back on db.
      console.log(JSON.stringify({ event: 'orca_relay_reserve_watch_verdict', mode: values.mode, verdict: values.verdict }))
      process.exitCode = 1
    } else {
      throw new Error('command must be watch, outcome, flip-back or alarm')
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'orca_relay_reserve_watch_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    process.exitCode = 1
  }
}
