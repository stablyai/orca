import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { relayOpsEnvironment } from './environment-config.js'
import { createGcloudClient } from './gcloud-client.js'
import { suppliedIdentityToken } from './incident-monitor-cli.js'
import {
  AdmissionSelectorSchema,
  normalizeSelectorMembership,
  SelectorMembershipSchema,
  type AdmissionSelector
} from './incident-selector.js'
import {
  evaluateIncidentSample,
  FRESHNESS_FAILURE_CODES,
  INCIDENT_MONITOR_THRESHOLDS,
  preDrainDryRunPassed,
  toleratedStreakKey,
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
// 2 for a general cell's isolate-and-restore wave, 0 for a migration-only cell's no-op pair.
const SELECTOR_WAVE_DELTA_PATTERN = /^[02]$/

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

const PREFLIGHT_USAGE =
  'usage: --state-file <verified-monitor-state> [--wave-index <0-3>]' +
  ' [--selector-wave-delta <0|2>] [--retry-freshness]' +
  ' | --no-monitor-state --expected-selector-generation <n>' +
  ' --selector-membership-file <json> [--wave-index <0-3>]' +
  ' [--selector-wave-delta <0|2>]'

const VALUE_OPTIONS = new Set([
  '--state-file',
  '--wave-index',
  '--selector-wave-delta',
  '--expected-selector-generation',
  '--selector-membership-file'
])
const FLAG_OPTIONS = new Set(['--retry-freshness', '--no-monitor-state'])

// Rejects an unknown option and a repeated one, so a typo can never silently
// widen what this check accepts.
export function parsePreflightArgs(argv: string[]): {
  options: Map<string, string>
  flags: Set<string>
} {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const options = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (FLAG_OPTIONS.has(arg)) {
      if (flags.has(arg)) throw new Error(PREFLIGHT_USAGE)
      flags.add(arg)
      continue
    }
    const value = args[index + 1]
    if (!VALUE_OPTIONS.has(arg) || options.has(arg) || !value) {
      throw new Error(PREFLIGHT_USAGE)
    }
    options.set(arg, value)
    index += 1
  }
  return { options, flags }
}

// What the live recheck measures the fleet against. Either source supplies the
// exact same fields; only where they come from and how they can go stale differs.
type PreflightPlan = {
  environment: 'production'
  expectedSelector: AdmissionSelector
  migrationPolicy: 'strict' | 'recover-forward' | 'capacity-transition'
  recoverySourceCellId: string | null
  capacityCellId: string | null
  // The instant the live samples age from. Monitor evidence ages from the moment
  // the 15-minute window closed; an override has no evidence to age, so its
  // retry budget starts when this process does.
  evidenceAnchorMs: number
}

async function monitorEvidencePreflightPlan(
  options: Map<string, string>,
  nowMs: number,
  waveIndex: string
): Promise<PreflightPlan> {
  const stateFile = options.get('--state-file')
  if (
    !stateFile ||
    options.has('--expected-selector-generation') ||
    options.has('--selector-membership-file')
  ) throw new Error(PREFLIGHT_USAGE)
  const state = PreflightStateSchema.parse(
    JSON.parse(await readFile(resolve(stateFile), 'utf8'))
  )
  const completedAt = Date.parse(state.completedAt)
  const windowStartedAt = Date.parse(state.windowStartedAt)
  const lastSampleAt = Date.parse(state.lastSampleAt)
  const evidenceAgeMs = nowMs - completedAt
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
  return {
    environment: state.environment,
    expectedSelector: state.expectedSelector,
    migrationPolicy: state.migrationPolicy,
    recoverySourceCellId: state.recoverySourceCellId,
    capacityCellId: state.capacityCellId,
    evidenceAnchorMs: completedAt
  }
}

// Break-glass: the caller authorized skipping the aggregate 15-minute monitor
// gate, so the expected selector comes straight from the dispatch inputs instead
// of sealed evidence. Nothing about this weakens the live sample below, and the
// policy is pinned to strict -- the only one the same-cap rollout ever verifies.
async function overridePreflightPlan(
  options: Map<string, string>,
  nowMs: number
): Promise<PreflightPlan> {
  const generation = options.get('--expected-selector-generation')
  const membershipFile = options.get('--selector-membership-file')
  if (!generation || !membershipFile || options.has('--state-file')) {
    throw new Error(PREFLIGHT_USAGE)
  }
  // Canonicalise exactly as the monitor CLI does when it seals evidence. The live
  // selector read from the director is normalised too and the comparison is an
  // ordered stringify, so unsorted operator input would read as selector drift on
  // a healthy fleet; normalising is also what enforces every configured cell
  // exactly once.
  const membership = normalizeSelectorMembership(
    SelectorMembershipSchema.parse(
      JSON.parse(await readFile(resolve(membershipFile), 'utf8'))
    ),
    new Set(relayOpsEnvironment('production').cells.map((cell) => cell.cellId))
  )
  return {
    environment: 'production',
    expectedSelector: AdmissionSelectorSchema.parse({
      generation: Number(generation),
      membership
    }),
    migrationPolicy: 'strict',
    recoverySourceCellId: null,
    capacityCellId: null,
    evidenceAnchorMs: nowMs
  }
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
  const parsed = parsePreflightArgs(argv)
  const waveIndex = parsed.options.get('--wave-index') ?? '0'
  if (!WAVE_INDEX_PATTERN.test(waveIndex)) throw new Error(PREFLIGHT_USAGE)
  const selectorWaveDelta = parsed.options.get('--selector-wave-delta') ?? '2'
  if (!SELECTOR_WAVE_DELTA_PATTERN.test(selectorWaveDelta)) throw new Error(PREFLIGHT_USAGE)
  const now = dependencies.now ?? Date.now
  const plan = parsed.flags.has('--no-monitor-state')
    ? await overridePreflightPlan(parsed.options, now())
    : await monitorEvidencePreflightPlan(parsed.options, now(), waveIndex)
  const maxEvidenceAgeMs =
    MONITOR_EVIDENCE_MAX_AGE_MS + Number(waveIndex) * WAVE_PREDECESSOR_TIMEOUT_MS
  const gcloud = livePreflightGcloud(
    dependencies.gcloud ?? createGcloudClient(),
    dependencies.environment
  )
  // Each predecessor same-cap apply wave reversibly isolates and restores its
  // cell with membership unchanged (rollback is single-cell, so it never reaches
  // a later wave), so the live selector comparison must expect the wave-adjusted
  // generation. A general cell advances it by 2; a migration-only cell is already
  // isolated and stays that way, so its wave advances it by 0. A wave is never
  // mixed, so one delta covers every predecessor.
  const collectOptions = {
    environment: plan.environment,
    expectedSelector: {
      ...plan.expectedSelector,
      generation: plan.expectedSelector.generation + Number(selectorWaveDelta) * Number(waveIndex)
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
  const freshnessAttempts = parsed.flags.has('--retry-freshness') ? FRESHNESS_RETRY_ATTEMPTS : 1
  // Why: this single sample decides a mutating wave, so an Asia cell's ~30 s
  // "no healthy upstream" window, or a one-minute director instance-replacement
  // dip, could fail a wave here even after the 15-minute gate learned to ride it
  // out. Hold the two to the same tolerance. Unlike the freshness retry this
  // needs no flag, because a tolerated breach is never the operator's call to
  // waive.
  const cellProbeAttempts = 1 + INCIDENT_MONITOR_THRESHOLDS.cellProbeToleranceSamples
  const attempts = Math.max(freshnessAttempts, cellProbeAttempts)
  let freshnessRetries = freshnessAttempts - 1
  let cellProbeRetries = cellProbeAttempts - 1
  // Waiting must never carry the mutation past the same evidence-age bound the
  // entry check enforces, so the wave budget also caps the retry window.
  const budgetExhausted = (): boolean =>
    now() + FRESHNESS_RETRY_INTERVAL_MS - plan.evidenceAnchorMs > maxEvidenceAgeMs
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
      plan.migrationPolicy,
      plan.recoverySourceCellId,
      plan.capacityCellId
    )
    if (evaluation.status === 'green') return
    const freshnessFailures = evaluation.failures.filter((failure) =>
      FRESHNESS_FAILURE_CODES.has(failure.code)
    )
    // Tolerated readings only (per-cell probes and the director instance count).
    // The director and auth health probes are absent here on purpose and fail
    // the wave on their first bad sample.
    const cellProbeFailures = evaluation.failures.filter((failure) =>
      !FRESHNESS_FAILURE_CODES.has(failure.code) && toleratedStreakKey(failure) !== null
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
