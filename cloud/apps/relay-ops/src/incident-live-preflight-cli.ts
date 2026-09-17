import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createGcloudClient } from './gcloud-client.js'
import { suppliedIdentityToken } from './incident-monitor-cli.js'
import { AdmissionSelectorSchema, type AdmissionSelector } from './incident-selector.js'
import {
  cellProbeStreakKey,
  evaluateIncidentSample,
  FRESHNESS_FAILURE_CODES,
  INCIDENT_MONITOR_THRESHOLDS,
  preDrainDryRunPassed,
  type IncidentFailure,
  type IncidentSample
} from './incident-monitor.js'
import { createIncidentSampleCollector } from './incident-monitor-sources.js'

const FRESHNESS_RETRY_ATTEMPTS = 5
const FRESHNESS_RETRY_INTERVAL_MS = 15_000
// 10 min, not 5: the same-cap job reaches this check ~5 min after the monitor
// completes (runner queue ~2 min, gate job ~80 s, checkout ~60 s); on 2026-09-17
// a green gate died at 302 s. The live samples below hold every wave to now.
const MONITOR_EVIDENCE_MAX_AGE_MS = 10 * 60_000
// Matches the same-cap cell job timeout-minutes; bounds each predecessor wave.
const WAVE_PREDECESSOR_TIMEOUT_MS = 75 * 60_000
const WAVE_INDEX_PATTERN = /^[0-3]$/

export function livePreflightGcloud(
  gcloud: ReturnType<typeof createGcloudClient>,
  environment: NodeJS.ProcessEnv = process.env
): ReturnType<typeof createGcloudClient> {
  const token = suppliedIdentityToken(environment.ORCA_RELAY_ADMIN_ID_TOKEN)
  return token ? { ...gcloud, identityToken: async () => token } : gcloud
}

const PreflightStateSchema = z.object({
  schemaVersion: z.literal(4),
  environment: z.literal('production'),
  expectedSelector: AdmissionSelectorSchema,
  migrationPolicy: z.enum(['strict', 'recover-forward', 'capacity-transition']),
  recoverySourceCellId: z.string().nullable(),
  capacityCellId: z.string().nullable(),
  preDrainDryRun: z.literal(true),
  startedAt: z.string(),
  windowStartedAt: z.string(),
  durationMinutes: z.literal(15),
  intervalMs: z.literal(60_000),
  sampleCount: z.number().int().min(16),
  lastSampleAt: z.string(),
  frozenAt: z.null(),
  completedAt: z.string()
}).superRefine((state, context) => {
  const validRecovery =
    state.migrationPolicy === 'recover-forward' &&
    state.capacityCellId === null &&
    state.recoverySourceCellId !== null &&
    state.expectedSelector.membership.existingOnly.includes(
      state.recoverySourceCellId
    )
  const validStrict =
    state.migrationPolicy === 'strict' &&
    state.recoverySourceCellId === null &&
    state.capacityCellId === null
  const validCapacity =
    state.migrationPolicy === 'capacity-transition' &&
    state.recoverySourceCellId === null &&
    state.capacityCellId !== null &&
    state.expectedSelector.membership.general.includes(state.capacityCellId)
  if (!validRecovery && !validStrict && !validCapacity) {
    context.addIssue({
      code: 'custom',
      message: 'relay live preflight migration policy is invalid'
    })
  }
})

// Keep the source/code prefix other tooling matches on, then name the signal and
// its numbers so a frozen wave is attributable without re-reading the sample.
function describeFailure(failure: IncidentFailure): string {
  const detail = [
    failure.signal,
    failure.observed === undefined ? null : `observed=${failure.observed}`,
    failure.threshold === undefined ? null : `threshold=${failure.threshold}`
  ].filter((part): part is string => part !== null && part !== undefined)
  return [`${failure.source}/${failure.code}`, ...detail].join(' ')
}

export async function runIncidentLivePreflight(
  argv: string[],
  dependencies: {
    now?: () => number
    wait?: (ms: number) => Promise<void>
    collect?: (expectedSelector: AdmissionSelector) => Promise<IncidentSample>
    gcloud?: ReturnType<typeof createGcloudClient>
    environment?: NodeJS.ProcessEnv
  } = {}
): Promise<void> {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const freshnessRetryCount = args.filter((arg) => arg === '--retry-freshness').length
  const rest = args.filter((arg) => arg !== '--retry-freshness')
  const stateArgs: string[] = []
  let waveIndex = '0'
  let waveIndexCount = 0
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--wave-index') {
      waveIndexCount += 1
      waveIndex = rest[index + 1] ?? ''
      index += 1
    } else {
      stateArgs.push(rest[index] as string)
    }
  }
  if (
    freshnessRetryCount > 1 ||
    waveIndexCount > 1 ||
    !WAVE_INDEX_PATTERN.test(waveIndex) ||
    stateArgs.length !== 2 ||
    stateArgs[0] !== '--state-file' ||
    !stateArgs[1]
  ) {
    throw new Error(
      'usage: --state-file <verified-monitor-state> [--wave-index <0-3>] [--retry-freshness]'
    )
  }
  const state = PreflightStateSchema.parse(
    JSON.parse(await readFile(resolve(stateArgs[1]), 'utf8'))
  )
  const now = dependencies.now ?? Date.now
  const completedAt = Date.parse(state.completedAt)
  const windowStartedAt = Date.parse(state.windowStartedAt)
  const lastSampleAt = Date.parse(state.lastSampleAt)
  const evidenceAgeMs = now() - completedAt
  // Later same-cap waves start after sequential predecessor cell rolls, so the
  // freshness bound grows by one cell-job timeout per predecessor; the live
  // samples collected below still hold every wave to current health.
  const maxEvidenceAgeMs =
    MONITOR_EVIDENCE_MAX_AGE_MS + Number(waveIndex) * WAVE_PREDECESSOR_TIMEOUT_MS
  if (
    !preDrainDryRunPassed(state) ||
    !Number.isFinite(windowStartedAt) ||
    completedAt - windowStartedAt < 15 * 60_000 ||
    !Number.isFinite(lastSampleAt) ||
    lastSampleAt > completedAt ||
    completedAt - lastSampleAt > state.intervalMs ||
    !Number.isFinite(completedAt) ||
    evidenceAgeMs < 0 ||
    evidenceAgeMs > maxEvidenceAgeMs
  ) {
    throw new Error('relay live preflight monitor evidence is incomplete or stale')
  }
  const gcloud = livePreflightGcloud(
    dependencies.gcloud ?? createGcloudClient(),
    dependencies.environment
  )
  // Each predecessor same-cap apply wave reversibly isolates and restores its
  // cell, advancing the selector generation by exactly 2 with membership
  // unchanged (rollback is single-cell, so it never reaches a later wave), so
  // the live selector comparison must expect the wave-adjusted generation.
  const collectOptions = {
    environment: state.environment,
    expectedSelector: {
      ...state.expectedSelector,
      generation: state.expectedSelector.generation + 2 * Number(waveIndex)
    },
    ...(dependencies.now ? { now: dependencies.now } : {})
  }
  const injected = dependencies.collect
  const collect = injected
    ? () => injected(collectOptions.expectedSelector)
    : createIncidentSampleCollector(gcloud, collectOptions)
  const wait = dependencies.wait ?? ((ms: number) => new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, ms)
  }))
  const freshnessAttempts = freshnessRetryCount === 1 ? FRESHNESS_RETRY_ATTEMPTS : 1
  // Why: this single sample decides a mutating wave, so an Asia cell's ~30 s
  // "no healthy upstream" window could fail a wave here even after the 15-minute
  // gate learned to ride it out. Hold the two to the same tolerance. Unlike the
  // freshness retry this needs no flag, because a per-cell probe breach is never
  // the operator's call to waive.
  const cellProbeAttempts = 1 + INCIDENT_MONITOR_THRESHOLDS.cellProbeToleranceSamples
  const attempts = Math.max(freshnessAttempts, cellProbeAttempts)
  let freshnessRetries = freshnessAttempts - 1
  let cellProbeRetries = cellProbeAttempts - 1
  // Waiting must never carry the mutation past the same evidence-age bound the
  // entry check enforces, so the wave budget also caps the retry window.
  const budgetExhausted = (): boolean =>
    now() + FRESHNESS_RETRY_INTERVAL_MS - completedAt > maxEvidenceAgeMs
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A director admin read can fail on its own (its handler maps a Cloud SQL
    // pool timeout onto 404), which says nothing about relay health; spend an
    // attempt on it rather than failing the wave on one unlucky sample.
    let sample: IncidentSample
    try {
      sample = await collect()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'sample collection failed'
      if (attempt === attempts || budgetExhausted()) {
        throw new Error(`relay live preflight failed: collector: ${message}`)
      }
      console.warn(
        `relay live preflight re-sampling after collector failure (${attempt}/${attempts - 1})`
      )
      await wait(FRESHNESS_RETRY_INTERVAL_MS)
      continue
    }
    const evaluation = evaluateIncidentSample(
      sample,
      now(),
      state.migrationPolicy,
      state.recoverySourceCellId,
      state.capacityCellId
    )
    if (evaluation.status === 'green') return
    const freshnessFailures = evaluation.failures.filter((failure) =>
      FRESHNESS_FAILURE_CODES.has(failure.code)
    )
    // Per-cell probe breaches only. Director and auth probes are absent here on
    // purpose and fail the wave on their first bad sample.
    const cellProbeFailures = evaluation.failures.filter((failure) =>
      !FRESHNESS_FAILURE_CODES.has(failure.code) && cellProbeStreakKey(failure) !== null
    )
    const retryable =
      freshnessFailures.length + cellProbeFailures.length === evaluation.failures.length &&
      (freshnessFailures.length === 0 || freshnessRetries > 0) &&
      (cellProbeFailures.length === 0 || cellProbeRetries > 0)
    if (!retryable || attempt === attempts || budgetExhausted()) {
      throw new Error(
        `relay live preflight failed: ${evaluation.failures
          .map(describeFailure)
        .join(',')}`
      )
    }
    if (freshnessFailures.length > 0) freshnessRetries--
    if (cellProbeFailures.length > 0) cellProbeRetries--
    console.warn(
      `relay live preflight re-sampling after tolerable failure (${attempt}/${attempts - 1})`
    )
    await wait(FRESHNESS_RETRY_INTERVAL_MS)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIncidentLivePreflight(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'relay live preflight failed')
    process.exitCode = 1
  })
}
