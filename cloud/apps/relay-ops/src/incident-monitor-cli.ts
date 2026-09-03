import { randomUUID } from 'node:crypto'
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { relayOpsEnvironment } from './environment-config.js'
import { createGcloudClient } from './gcloud-client.js'
import {
  AdmissionSelectorSchema,
  normalizeSelectorMembership,
  type AdmissionSelector
} from './incident-selector.js'
import {
  initialIncidentMonitorState,
  preDrainDryRunPassed,
  runIncidentMonitor,
  type IncidentCheckpoint,
  type IncidentSample,
  type IncidentMonitorState
} from './incident-monitor.js'
import { createIncidentSampleCollector } from './incident-monitor-sources.js'

const StateSchema = z.object({
  schemaVersion: z.literal(4),
  incidentId: z.string(),
  environment: z.enum(['production', 'staging']),
  expectedSelector: AdmissionSelectorSchema,
  preDrainDryRun: z.boolean(),
  migrationPolicy: z.enum(['strict', 'recover-forward', 'capacity-transition']),
  recoverySourceCellId: z.string().nullable(),
  capacityCellId: z.string().nullable(),
  startedAt: z.string(),
  windowStartedAt: z.string().nullable(),
  windowSequence: z.number().int().nonnegative(),
  durationMinutes: z.number().int(),
  intervalMs: z.number().int(),
  nextCheckpointIndex: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  totalSampleCount: z.number().int().nonnegative(),
  lastSampleAt: z.string().nullable(),
  continuityEvents: z.array(z.object({
    recordedAt: z.string(),
    windowSequence: z.number().int().nonnegative(),
    failures: z.array(z.object({
      code: z.string(),
      source: z.enum(['active-probe', 'cloud-monitoring', 'relay-logs', 'director-admin']),
      signal: z.string().optional(),
      observed: z.number().optional(),
      threshold: z.number().optional()
    }))
  })),
  frozenAt: z.string().nullable(),
  failures: z.array(z.object({
    code: z.string(),
    source: z.enum(['active-probe', 'cloud-monitoring', 'relay-logs', 'director-admin']),
    signal: z.string().optional(),
    observed: z.number().optional(),
    threshold: z.number().optional()
  })),
  completedAt: z.string().nullable()
})

type CliOptions = {
  environment: 'production' | 'staging'
  incidentId: string
  durationMinutes: number
  intervalMs: number
  expectedSelector: AdmissionSelector
  stateFile: string
  summaryFile: string
  markdownFile: string
  restart: boolean
  preDrainDryRun: boolean
  migrationPolicy: 'strict' | 'recover-forward' | 'capacity-transition'
  recoverySourceCellId: string | null
  capacityCellId: string | null
  maxSamplesThisRun: number | null
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function parseIncidentMonitorArguments(argv: string[], cwd = process.cwd()): CliOptions {
  const flags = new Set(['restart', 'pre-drain-dry-run'])
  const valueArguments = new Set([
    'duration-minutes',
    'environment',
    'expected-selector-generation',
    'expected-existing-only-cells',
    'expected-migration-only-cells',
    'expected-general-cells',
    'incident-id',
    'interval-seconds',
    'max-samples-this-run',
    'migration-policy',
    'output-directory',
    'recovery-source-cell-id',
    'capacity-cell-id'
  ])
  const values: Record<string, string> = {}
  const enabledFlags = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (!argument?.startsWith('--')) throw new Error(`invalid argument ${argument ?? ''}`)
    const name = argument.slice(2)
    if (flags.has(name)) {
      enabledFlags.add(name)
      continue
    }
    if (!valueArguments.has(name)) throw new Error(`unknown argument --${name}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`missing --${name} value`)
    values[name] = value
  }
  const environment = z.enum(['production', 'staging']).parse(
    values.environment ?? 'production'
  )
  const incidentId = values['incident-id'] ?? randomUUID()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/.test(incidentId)) {
    throw new Error('--incident-id must be 8-128 safe characters')
  }
  const selectorGeneration = Number(values['expected-selector-generation'])
  if (!Number.isSafeInteger(selectorGeneration) || selectorGeneration < 0) {
    throw new Error('--expected-selector-generation must be a nonnegative integer')
  }
  const configuredCells = new Set(
    relayOpsEnvironment(environment).cells.map((cell) => cell.cellId)
  )
  const cellList = (name: string): string[] => {
    const value = values[name]
    if (value === undefined) throw new Error(`--${name} is required; use none for an empty set`)
    return value === 'none' ? [] : value.split(',').map((cellId) => cellId.trim())
  }
  const expectedSelector = {
    generation: selectorGeneration,
    membership: normalizeSelectorMembership(
      {
        existingOnly: cellList('expected-existing-only-cells'),
        migrationOnly: cellList('expected-migration-only-cells'),
        general: cellList('expected-general-cells')
      },
      configuredCells
    )
  }
  if (selectorGeneration === 0 && expectedSelector.membership.migrationOnly.length > 0) {
    throw new Error('generation 0 cannot represent migration-only admission')
  }
  const preDrainDryRun = enabledFlags.has('pre-drain-dry-run')
  const migrationPolicy = z.enum([
    'strict',
    'recover-forward',
    'capacity-transition'
  ]).parse(
    values['migration-policy'] ?? 'strict'
  )
  const recoverySourceCellId =
    values['recovery-source-cell-id'] === undefined ||
    values['recovery-source-cell-id'] === 'none'
      ? null
      : values['recovery-source-cell-id']
  const capacityCellId =
    values['capacity-cell-id'] === undefined || values['capacity-cell-id'] === 'none'
      ? null
      : values['capacity-cell-id']
  const durationMinutes = parsePositiveInteger(
    values['duration-minutes'] ?? (preDrainDryRun ? '15' : '90'),
    '--duration-minutes'
  )
  const intervalMs =
    parsePositiveInteger(values['interval-seconds'] ?? '60', '--interval-seconds') * 1_000
  if (durationMinutes < 15 || durationMinutes > 90) {
    throw new Error('--duration-minutes must be between 15 and 90')
  }
  if (intervalMs > 60_000) {
    throw new Error('--interval-seconds must be between 1 and 60')
  }
  if (preDrainDryRun && durationMinutes !== 15) {
    throw new Error('--pre-drain-dry-run requires --duration-minutes 15')
  }
  if (migrationPolicy !== 'strict' && !preDrainDryRun) {
    throw new Error(`--migration-policy ${migrationPolicy} requires --pre-drain-dry-run`)
  }
  if (
    migrationPolicy === 'recover-forward' &&
    (
      recoverySourceCellId === null ||
      !configuredCells.has(recoverySourceCellId) ||
      !expectedSelector.membership.existingOnly.includes(recoverySourceCellId)
    )
  ) {
    throw new Error(
      '--migration-policy recover-forward requires an existing-only --recovery-source-cell-id'
    )
  }
  if (migrationPolicy !== 'recover-forward' && recoverySourceCellId !== null) {
    throw new Error('--recovery-source-cell-id requires --migration-policy recover-forward')
  }
  if (
    migrationPolicy === 'capacity-transition' &&
    (
      capacityCellId === null ||
      !configuredCells.has(capacityCellId) ||
      !expectedSelector.membership.general.includes(capacityCellId)
    )
  ) {
    throw new Error(
      '--migration-policy capacity-transition requires a general --capacity-cell-id'
    )
  }
  if (migrationPolicy !== 'capacity-transition' && capacityCellId !== null) {
    throw new Error('--capacity-cell-id requires --migration-policy capacity-transition')
  }
  const directory = resolve(cwd, values['output-directory'] ?? '.relay-incidents')
  const maxSamplesThisRun = values['max-samples-this-run']
    ? parsePositiveInteger(values['max-samples-this-run'], '--max-samples-this-run')
    : null
  return {
    environment,
    incidentId,
    durationMinutes,
    intervalMs,
    expectedSelector,
    stateFile: resolve(directory, `${incidentId}.state.json`),
    summaryFile: resolve(directory, `${incidentId}.summaries.jsonl`),
    markdownFile: resolve(directory, `${incidentId}.summary.md`),
    restart: enabledFlags.has('restart'),
    preDrainDryRun,
    migrationPolicy,
    recoverySourceCellId,
    capacityCellId,
    maxSamplesThisRun
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function persistState(path: string, state: IncidentMonitorState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await syncFile(temporaryPath)
  await rename(temporaryPath, path)
  await syncFile(path)
}

async function appendCheckpoint(path: string, checkpoint: IncidentCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700)
  if (await fileExists(path)) {
    const existing = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IncidentCheckpoint)
    if (
      existing.some((entry) =>
        entry.windowSequence === checkpoint.windowSequence &&
        entry.checkpointMinute === checkpoint.checkpointMinute
      )
    ) return
  }
  await appendFile(path, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
  await syncFile(path)
}

function markdownFailure(checkpoint: IncidentCheckpoint): string {
  if (checkpoint.failures.length === 0) return 'none'
  return checkpoint.failures
    .map((failure) => {
      const signal = failure.signal ? `/${failure.signal}` : ''
      return `${failure.source}/${failure.code}${signal}`
    })
    .join(', ')
}

async function writeMarkdownSummary(
  path: string,
  summaryPath: string,
  incidentId: string,
  environment: string
): Promise<void> {
  const checkpoints = (await readFile(summaryPath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IncidentCheckpoint)
  const rows = checkpoints.map((checkpoint) => [
    `| ${checkpoint.windowSequence}`,
    checkpoint.checkpointMinute,
    checkpoint.status,
    checkpoint.sampleCount,
    `${markdownFailure(checkpoint)} |`
  ].join(' | '))
  const markdown = [
    '# Relay incident monitor',
    '',
    `Incident: \`${incidentId}\``,
    '',
    `Environment: \`${environment}\``,
    '',
    `Expected selector: \`${JSON.stringify(checkpoints[0]?.expectedSelector ?? null)}\``,
    '',
    `Migration policy: \`${checkpoints[0]?.migrationPolicy ?? 'unknown'}\``,
    '',
    `Recovery source: \`${checkpoints[0]?.recoverySourceCellId ?? 'none'}\``,
    '',
    `Capacity cell: \`${checkpoints[0]?.capacityCellId ?? 'none'}\``,
    '',
    '| Window | Minute | Status | Samples | Failures |',
    '| ---: | ---: | --- | ---: | --- |',
    ...rows,
    ''
  ].join('\n')
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, markdown, { mode: 0o600 })
  await chmod(temporaryPath, 0o600)
  await syncFile(temporaryPath)
  await rename(temporaryPath, path)
  await syncFile(path)
}

export function suppliedIdentityToken(value: string | undefined): string | null {
  if (value === undefined) return null
  if (
    value.length > 8_192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error('ORCA_RELAY_ADMIN_ID_TOKEN is invalid')
  }
  return value
}

async function readInitialState(
  options: CliOptions,
  now: () => number = Date.now
): Promise<IncidentMonitorState> {
  const exists = await fileExists(options.stateFile)
  if (exists && !options.restart) {
    throw new Error('incident state already exists; pass --restart to resume it')
  }
  if (!exists && options.restart) throw new Error('no incident state exists to restart')
  if (!exists) {
    return initialIncidentMonitorState({
      incidentId: options.incidentId,
      environment: options.environment,
      expectedSelector: options.expectedSelector,
      preDrainDryRun: options.preDrainDryRun,
      migrationPolicy: options.migrationPolicy,
      recoverySourceCellId: options.recoverySourceCellId,
      capacityCellId: options.capacityCellId,
      startedAt: new Date(now()).toISOString(),
      durationMinutes: options.durationMinutes,
      intervalMs: options.intervalMs
    })
  }
  const state = StateSchema.parse(
    JSON.parse(await readFile(options.stateFile, 'utf8'))
  ) as IncidentMonitorState
  if (
    state.incidentId !== options.incidentId ||
    state.environment !== options.environment ||
    JSON.stringify(state.expectedSelector) !== JSON.stringify(options.expectedSelector) ||
    state.preDrainDryRun !== options.preDrainDryRun ||
    state.migrationPolicy !== options.migrationPolicy ||
    state.recoverySourceCellId !== options.recoverySourceCellId ||
    state.capacityCellId !== options.capacityCellId ||
    state.durationMinutes !== options.durationMinutes ||
    state.intervalMs !== options.intervalMs
  ) {
    throw new Error('restart arguments do not match durable incident state')
  }
  return state
}

export async function runIncidentMonitorCli(
  argv: string[],
  dependencies: {
    cwd?: string
    now?: () => number
    wait?: (ms: number) => Promise<void>
    gcloud?: ReturnType<typeof createGcloudClient>
    collect?: () => Promise<IncidentSample>
    writeOutput?: (value: string) => void
    environment?: NodeJS.ProcessEnv
  } = {}
): Promise<number> {
  const options = parseIncidentMonitorArguments(argv, dependencies.cwd)
  const state = await readInitialState(options, dependencies.now)
  const baseGcloud = dependencies.gcloud ?? createGcloudClient()
  const token = suppliedIdentityToken(
    (dependencies.environment ?? process.env).ORCA_RELAY_ADMIN_ID_TOKEN
  )
  await persistState(options.stateFile, state)
  const gcloud = token
    ? { ...baseGcloud, identityToken: async () => token }
    : baseGcloud
  const collect =
    dependencies.collect ??
    createIncidentSampleCollector(gcloud, {
      environment: options.environment,
      expectedSelector: options.expectedSelector,
      ...(dependencies.now ? { now: dependencies.now } : {})
    })
  let samplesThisRun = 0
  const segmentedCollect = async (): Promise<IncidentSample> => {
    try {
      return await collect()
    } finally {
      samplesThisRun++
    }
  }
  const wait =
    dependencies.wait ??
    ((ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)))
  const segmentComplete = Symbol('segment-complete')
  const output = dependencies.writeOutput ?? ((value) => process.stdout.write(`${value}\n`))
  let result: IncidentMonitorState
  try {
    result = await runIncidentMonitor(state, {
      now: dependencies.now ?? Date.now,
      wait: async (ms) => {
        if (
          options.maxSamplesThisRun !== null &&
          samplesThisRun >= options.maxSamplesThisRun
        ) {
          throw segmentComplete
        }
        await wait(ms)
      },
      collect: segmentedCollect,
      persist: async (nextState) => await persistState(options.stateFile, nextState),
      checkpoint: async (checkpoint) => {
        await appendCheckpoint(options.summaryFile, checkpoint)
        await writeMarkdownSummary(
          options.markdownFile,
          options.summaryFile,
          options.incidentId,
          options.environment
        )
        output(JSON.stringify(checkpoint))
      }
    })
  } catch (error) {
    if (error !== segmentComplete) throw error
    return 0
  }
  if (options.preDrainDryRun && !preDrainDryRunPassed(result)) return 2
  return result.frozenAt ? 2 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIncidentMonitorCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'incident monitor failed')
      process.exitCode = 1
    })
}
