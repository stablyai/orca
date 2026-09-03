import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createGcloudClient } from './gcloud-client.js'
import { suppliedIdentityToken } from './incident-monitor-cli.js'
import { AdmissionSelectorSchema, type AdmissionSelector } from './incident-selector.js'
import {
  evaluateIncidentSample,
  preDrainDryRunPassed,
  type IncidentSample
} from './incident-monitor.js'
import { createIncidentSampleCollector } from './incident-monitor-sources.js'

const FRESHNESS_RETRY_ATTEMPTS = 5
const FRESHNESS_RETRY_INTERVAL_MS = 15_000
const MONITOR_EVIDENCE_MAX_AGE_MS = 5 * 60_000
// Matches the same-cap cell job timeout-minutes; bounds each predecessor wave.
const WAVE_PREDECESSOR_TIMEOUT_MS = 75 * 60_000
const WAVE_INDEX_PATTERN = /^[0-3]$/
const FRESHNESS_FAILURE_CODES = new Set([
  'signal_missing',
  'signal_stale',
  'source_missing',
  'source_stale'
])

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
  const attempts = freshnessRetryCount === 1 ? FRESHNESS_RETRY_ATTEMPTS : 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const evaluation = evaluateIncidentSample(
      await collect(),
      now(),
      state.migrationPolicy,
      state.recoverySourceCellId,
      state.capacityCellId
    )
    if (evaluation.status === 'green') return
    const freshnessOnly = evaluation.failures.every((failure) =>
      FRESHNESS_FAILURE_CODES.has(failure.code)
    )
    if (!freshnessOnly || attempt === attempts) {
      throw new Error(
        `relay live preflight failed: ${evaluation.failures
          .map((failure) => `${failure.source}/${failure.code}`)
        .join(',')}`
      )
    }
    console.warn(
      `relay live preflight awaiting fresh evidence (${attempt}/${attempts - 1})`
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
