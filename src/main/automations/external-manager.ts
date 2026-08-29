/* eslint-disable max-lines -- Why: external automation discovery, pagination,
 * and lifecycle routing share provider/target validation and remote relay fallbacks. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type {
  ExternalAutomationAction,
  ExternalAutomationActionInput,
  ExternalAutomationCreateInput,
  ExternalAutomationManager,
  ExternalAutomationProvider,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput
} from '../../shared/automations-types'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError,
  type ScopedExternalAutomationRequest,
  type ScopedExternalManagerActionRequest,
  type ScopedExternalManagerCreateRequest,
  type ScopedExternalManagerListRequest,
  type ScopedExternalManagerMutationFields,
  type ScopedExternalManagerRunsRequest,
  type ScopedExternalManagerUpdateRequest
} from '../../shared/external-automation-scope'
import type { SshTarget } from '../../shared/ssh-types'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import {
  resolveExternalAutomationScope,
  type DesktopSshTargetRegistry,
  type ResolvedExternalAutomationScope
} from './external-automation-owner-guard'
import {
  externalAutomationManagerCacheKey,
  type ExternalAutomationManagerCache,
  type ExternalAutomationManagerCacheEntry
} from './external-automation-manager-cache'
import type { ExternalAutomationProbeScheduler } from './external-automation-probe-scheduler'
import { mapHermesJobs, mapOpenClawJobs } from './external-job-mappers'
import {
  clearHermesCronOutputRunCountCache,
  readHermesCronOutputRunsPage
} from './hermes-cron-output'

const HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
const HERMES_CRON_DIR = join(HERMES_HOME, 'cron')
const HERMES_JOBS_FILE = join(HERMES_CRON_DIR, 'jobs.json')
const OPENCLAW_JOBS_FILE = join(homedir(), '.openclaw', 'cron', 'jobs.json')
const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const LOCAL_COMMAND_LOOKUP_TIMEOUT_MS = 5_000
const LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS = 30_000
const PROVIDER_LABELS: Record<ExternalAutomationProvider, string> = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runLocalProviderCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; timeoutMessage: string }
): Promise<void> {
  return runProcess({ program: command, args, timeoutMs: options.timeoutMs }).then((result) => {
    if (result.timedOut) {
      throw new Error(options.timeoutMessage)
    }
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() || `Command exited with code ${result.code ?? 'unknown'}.`
      )
    }
  })
}

async function isCommandOnPath(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    // Why: these probes run while loading Automations; a wedged PATH shim must
    // not keep the list IPC pending forever.
    await runLocalProviderCommand(finder, [command], {
      timeoutMs: LOCAL_COMMAND_LOOKUP_TIMEOUT_MS,
      timeoutMessage: `Command lookup timed out after ${LOCAL_COMMAND_LOOKUP_TIMEOUT_MS}ms.`
    })
    return true
  } catch {
    return false
  }
}

// Why: local automation mutations back UI actions; a wedged CLI must not keep
// create/edit/run/delete pending after Node signals a timeout.
function runLocalAutomationCommand(command: string, args: string[]): Promise<void> {
  return runLocalProviderCommand(command, args, {
    timeoutMs: LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS,
    timeoutMessage: `Local automation command timed out after ${LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS}ms.`
  })
}

async function readLocalHermesJobs(): Promise<unknown[]> {
  if (!existsSync(HERMES_JOBS_FILE)) {
    return []
  }
  const content = await readFile(HERMES_JOBS_FILE, 'utf-8')
  const parsed = JSON.parse(content) as unknown
  const jobs = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : []
  return Promise.all(
    jobs.map(async (job) => {
      if (!isRecord(job)) {
        return job
      }
      const jobId = typeof job.id === 'string' ? job.id : null
      if (!jobId) {
        return job
      }
      const runsPage = await readHermesCronOutputRunsPage(jobId, { page: 1, pageSize: 0 })
      return {
        ...job,
        run_count: runsPage.total,
        runs: []
      }
    })
  )
}

async function readLocalOpenClawJobs(): Promise<unknown[]> {
  if (!existsSync(OPENCLAW_JOBS_FILE)) {
    return []
  }
  const content = await readFile(OPENCLAW_JOBS_FILE, 'utf-8')
  const parsed = JSON.parse(content) as unknown
  return isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : []
}

function mapProviderJobs(
  provider: ExternalAutomationProvider,
  managerId: string,
  jobs: unknown[]
): ExternalAutomationManager['jobs'] {
  return provider === 'hermes' ? mapHermesJobs(managerId, jobs) : mapOpenClawJobs(managerId, jobs)
}

async function listLocalManager(
  provider: ExternalAutomationProvider
): Promise<ExternalAutomationManager | null> {
  const [availableResult, jobsResult] = await Promise.allSettled([
    isCommandOnPath(provider),
    provider === 'hermes' ? readLocalHermesJobs() : readLocalOpenClawJobs()
  ])
  const available = availableResult.status === 'fulfilled' && availableResult.value
  const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : []
  const readError = jobsResult.status === 'rejected' ? String(jobsResult.reason) : null
  if (!available && jobs.length === 0 && !readError) {
    return null
  }
  const managerId = `${provider}:local`
  const providerLabel = PROVIDER_LABELS[provider]
  return {
    id: managerId,
    provider,
    label: `${providerLabel} on this computer`,
    targetLabel: 'this computer',
    target: { type: 'local' },
    status: readError ? 'unavailable' : 'available',
    error:
      readError ??
      (available
        ? null
        : `${providerLabel} jobs were found, but the ${provider} CLI is not on PATH.`),
    canManage: !readError && available,
    jobs: mapProviderJobs(provider, managerId, jobs)
  }
}

function requireMultiplexer(
  connectionId: string
): NonNullable<ReturnType<typeof getActiveMultiplexer>> {
  const mux = getActiveMultiplexer(connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error(`SSH target "${connectionId}" is not connected.`)
  }
  return mux
}

/**
 * True only for a structured JSON-RPC `-32601`, never for error prose.
 *
 * A `-32601` object means the peer parsed the request and declined the method,
 * so it is positive evidence the connection is healthy. Matching the words
 * "method not found" instead would let a genuinely broken relay be reported as
 * a missing capability, hiding a dead connection behind a capability notice.
 */
function isRelayMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === JsonRpcErrorCode.MethodNotFound
  )
}

function remoteRelayErrorMessage(error: unknown): string {
  if (isRelayMethodNotFoundError(error)) {
    return 'Remote relay does not support external automation management. Reconnect the SSH target to deploy the latest relay.'
  }
  return error instanceof Error ? error.message : String(error)
}

async function listRemoteManager(
  target: SshTarget,
  provider: ExternalAutomationProvider
): Promise<ExternalAutomationManager> {
  const providerLabel = PROVIDER_LABELS[provider]
  const managerProviderId = `${provider}:ssh:${target.id}`
  const mux = getActiveMultiplexer(target.id)
  if (!mux || mux.isDisposed()) {
    return {
      id: managerProviderId,
      provider,
      label: `${providerLabel} on ${target.label}`,
      targetLabel: target.label,
      target: { type: 'ssh', connectionId: target.id },
      status: 'unavailable',
      error: 'SSH target is not connected.',
      canManage: false,
      jobs: []
    }
  }
  try {
    const result = (await mux.request('externalAutomations.list', { provider })) as {
      jobs?: unknown[]
      hermesAvailable?: boolean
      openclawAvailable?: boolean
      error?: string | null
    }
    const commandAvailable =
      provider === 'hermes' ? result.hermesAvailable === true : result.openclawAvailable === true
    const readError = result.error ?? null
    return {
      id: managerProviderId,
      provider,
      label: `${providerLabel} on ${target.label}`,
      targetLabel: target.label,
      target: { type: 'ssh', connectionId: target.id },
      status: readError ? 'unavailable' : 'available',
      error:
        readError ?? (commandAvailable ? null : `${providerLabel} CLI is not on the remote PATH.`),
      canManage: !readError && commandAvailable,
      jobs: mapProviderJobs(provider, managerProviderId, result.jobs ?? [])
    }
  } catch (error) {
    return {
      id: managerProviderId,
      provider,
      label: `${providerLabel} on ${target.label}`,
      targetLabel: target.label,
      target: { type: 'ssh', connectionId: target.id },
      status: 'unavailable',
      error: remoteRelayErrorMessage(error),
      canManage: false,
      jobs: []
    }
  }
}

/**
 * Runs the relay's paged runs call, translating "no such method" into a code the
 * renderer can act on.
 *
 * The structured code exists only here: Electron IPC preserves nothing but the
 * message, so a renderer that re-derived this from the host's prose would be
 * guessing. Translating at the boundary that can still see the code is what lets
 * the caller fall back to job-carried runs without matching free text.
 */
async function requestRemoteExternalRuns(
  connectionId: string,
  params: { provider: ExternalAutomationProvider; jobId: string; page: number; pageSize: number }
): Promise<{ total?: number; runs?: unknown[] }> {
  try {
    return (await requireMultiplexer(connectionId).request('externalAutomations.runs', params)) as {
      total?: number
      runs?: unknown[]
    }
  } catch (error) {
    if (isRelayMethodNotFoundError(error)) {
      throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.runsUnsupported)
    }
    throw error
  }
}

export async function listExternalAutomationRuns(
  input: ExternalAutomationRunsInput
): Promise<ExternalAutomationRunsPage> {
  if (!EXTERNAL_JOB_ID_PATTERN.test(input.jobId)) {
    throw new Error('Invalid external automation job ID.')
  }
  const page = Number.isFinite(input.page) ? Math.max(1, Math.floor(input.page)) : 1
  const pageSize = Number.isFinite(input.pageSize)
    ? Math.min(100, Math.max(1, Math.floor(input.pageSize)))
    : 25
  const identity = {
    managerId: input.managerId,
    provider: input.provider,
    target: input.target,
    jobId: input.jobId,
    page,
    pageSize
  }
  if (input.provider !== 'hermes') {
    return { ...identity, total: 0, runs: [] }
  }
  const result =
    input.target.type === 'local'
      ? await readHermesCronOutputRunsPage(input.jobId, { page, pageSize })
      : await requestRemoteExternalRuns(input.target.connectionId, {
          provider: input.provider,
          jobId: input.jobId,
          page,
          pageSize
        })
  return {
    ...identity,
    total: typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : 0,
    runs:
      mapHermesJobs(input.managerId, [{ id: input.jobId, runs: result.runs ?? [] }])[0]?.runs ?? []
  }
}

const PROVIDER_ACTION_COMMANDS: Record<
  ExternalAutomationProvider,
  Record<ExternalAutomationAction, string>
> = {
  hermes: { pause: 'pause', resume: 'resume', run: 'run', delete: 'remove' },
  openclaw: { pause: 'disable', resume: 'enable', run: 'run', delete: 'rm' }
}

/** Fails closed like its neighbours: an unlisted or inherited key is not an action. */
function providerActionCommand(
  provider: ExternalAutomationProvider,
  action: ExternalAutomationAction
): string {
  const commands = Object.hasOwn(PROVIDER_ACTION_COMMANDS, provider)
    ? PROVIDER_ACTION_COMMANDS[provider]
    : null
  const command = commands && Object.hasOwn(commands, action) ? commands[action] : null
  if (typeof command !== 'string') {
    throw new Error('Unsupported external automation action.')
  }
  return command
}

function normalizeHermesCronMutationInput(input: ExternalAutomationCreateInput): {
  name: string
  prompt: string
  schedule: string
  workdir: string | null
} {
  if (input.provider !== 'hermes') {
    throw new Error('Only Hermes cron creation and editing are supported.')
  }
  const name = input.name.trim()
  const prompt = input.prompt.trim()
  const schedule = input.schedule.trim()
  const workdir = input.workdir?.trim() || null
  if (!prompt) {
    throw new Error('Hermes cron requires a prompt.')
  }
  if (!schedule) {
    throw new Error('Hermes cron requires a schedule.')
  }
  return {
    name: name || prompt.slice(0, 50).trim() || 'Hermes cron',
    prompt,
    schedule,
    workdir
  }
}

/** Edit args when `jobId` is given, create args otherwise; both are argv, never a shell string. */
function hermesCronMutationArgs(
  jobId: string | null,
  input: { name: string; prompt: string; schedule: string; workdir: string | null }
): string[] {
  const args = jobId
    ? ['cron', 'edit', jobId, '--schedule', input.schedule, '--prompt', input.prompt]
    : ['cron', 'create', input.schedule, input.prompt]
  args.push('--name', input.name)
  if (!jobId) {
    args.push('--deliver', 'local')
  }
  if (input.workdir) {
    args.push('--workdir', input.workdir)
  }
  return args
}

export async function createExternalAutomation(
  input: ExternalAutomationCreateInput
): Promise<void> {
  const normalized = normalizeHermesCronMutationInput(input)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand('hermes', hermesCronMutationArgs(null, normalized))
    clearHermesCronOutputRunCountCache()
    return
  }
  await requireMultiplexer(input.target.connectionId).request('externalAutomations.create', {
    provider: input.provider,
    ...normalized
  })
}

export async function updateExternalAutomation(
  input: ExternalAutomationUpdateInput
): Promise<void> {
  if (!EXTERNAL_JOB_ID_PATTERN.test(input.jobId)) {
    throw new Error('Invalid external automation job ID.')
  }
  const normalized = normalizeHermesCronMutationInput(input)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand('hermes', hermesCronMutationArgs(input.jobId, normalized))
    clearHermesCronOutputRunCountCache(input.jobId)
    return
  }
  await requireMultiplexer(input.target.connectionId).request('externalAutomations.update', {
    provider: input.provider,
    jobId: input.jobId,
    ...normalized
  })
}

export async function runExternalAutomationAction(
  input: ExternalAutomationActionInput
): Promise<void> {
  if (!EXTERNAL_JOB_ID_PATTERN.test(input.jobId)) {
    throw new Error('Invalid external automation job ID.')
  }
  const command = providerActionCommand(input.provider, input.action)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand(input.provider, ['cron', command, input.jobId])
    if (input.provider === 'hermes') {
      clearHermesCronOutputRunCountCache(input.jobId)
    }
    return
  }
  await requireMultiplexer(input.target.connectionId).request('externalAutomations.act', {
    provider: input.provider,
    action: input.action,
    jobId: input.jobId
  })
}

export type ScopedExternalAutomationDeps = {
  registry: DesktopSshTargetRegistry
  scheduler: ExternalAutomationProbeScheduler
  cache: ExternalAutomationManagerCache
}

export type ScopedExternalAutomations = {
  listManager: (
    request: ScopedExternalManagerListRequest
  ) => Promise<ExternalAutomationManagerCacheEntry>
  listRuns: (request: ScopedExternalManagerRunsRequest) => Promise<ExternalAutomationRunsPage>
  create: (request: ScopedExternalManagerCreateRequest) => Promise<void>
  update: (request: ScopedExternalManagerUpdateRequest) => Promise<void>
  runAction: (request: ScopedExternalManagerActionRequest) => Promise<void>
}

/**
 * Scoped entry points: one captured desktop owner in, one host's managers out.
 * Every call re-resolves its scope before any probe, so a host that changed under
 * a held-open dialog fails closed instead of acting on the new incarnation.
 */
export function createScopedExternalAutomations(
  deps: ScopedExternalAutomationDeps
): ScopedExternalAutomations {
  const resolve = (request: ScopedExternalAutomationRequest): ResolvedExternalAutomationScope =>
    resolveExternalAutomationScope(request, deps.registry)
  const mutationInput = (
    scope: ResolvedExternalAutomationScope,
    fields: ScopedExternalManagerMutationFields
  ): ExternalAutomationCreateInput => ({
    managerId: scope.managerId,
    provider: scope.provider,
    target: scope.target,
    name: fields.name,
    prompt: fields.prompt,
    schedule: fields.schedule,
    workdir: fields.workdir
  })

  return {
    async listManager(request) {
      const scope = resolve(request)
      const key = { ownerKey: scope.ownerKey, provider: scope.provider }
      return await deps.cache.resolve(
        key,
        () =>
          deps.scheduler.schedule({
            key: externalAutomationManagerCacheKey(key),
            scopeKey: scope.ownerKey,
            run: () =>
              scope.sshTarget
                ? listRemoteManager(scope.sshTarget, scope.provider)
                : listLocalManager(scope.provider)
          }),
        { refresh: request.refresh }
      )
    },
    async listRuns(request) {
      const scope = resolve(request)
      return await listExternalAutomationRuns({
        managerId: scope.managerId,
        provider: scope.provider,
        target: scope.target,
        jobId: request.jobId,
        page: request.page,
        pageSize: request.pageSize
      })
    },
    async create(request) {
      const scope = resolve(request)
      await createExternalAutomation(mutationInput(scope, request))
      deps.cache.invalidateOwner(scope.ownerKey)
    },
    async update(request) {
      const scope = resolve(request)
      await updateExternalAutomation({ ...mutationInput(scope, request), jobId: request.jobId })
      deps.cache.invalidateOwner(scope.ownerKey)
    },
    async runAction(request) {
      const scope = resolve(request)
      await runExternalAutomationAction({
        managerId: scope.managerId,
        provider: scope.provider,
        target: scope.target,
        jobId: request.jobId,
        action: request.action
      })
      deps.cache.invalidateOwner(scope.ownerKey)
    }
  }
}
