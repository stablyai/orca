/* eslint-disable max-lines -- Why: external automation discovery, pagination,
 * and lifecycle routing share provider/target validation and remote relay fallbacks. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { getActiveMultiplexer } from '../ipc/ssh'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function isCommandOnPath(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    await runLocalCommandLookup(finder, [command])
    return true
  } catch {
    return false
  }
}

function runLocalCommandLookup(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile> | null = null
    let settled = false

    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    // Why: these probes run while loading Automations; a wedged PATH shim must
    // not keep the list IPC pending forever.
    const timeout = setTimeout(() => {
      child?.kill()
      finish(new Error(`Command lookup timed out after ${LOCAL_COMMAND_LOOKUP_TIMEOUT_MS}ms.`))
    }, LOCAL_COMMAND_LOOKUP_TIMEOUT_MS)

    try {
      child = execFile(command, args, { encoding: 'utf-8' }, (error) => {
        finish(error ?? null)
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function runLocalAutomationCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile> | null = null
    let settled = false

    const finish = (error: Error | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (error) {
        reject(error)
        return
      }
      resolve()
    }

    // Why: local automation mutations back UI actions; a wedged CLI must not
    // keep create/edit/run/delete pending after Node signals a timeout.
    const timeout = setTimeout(() => {
      child?.kill()
      finish(
        new Error(
          `Local automation command timed out after ${LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS}ms.`
        )
      )
    }, LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS)

    try {
      child = execFile(
        command,
        args,
        { encoding: 'utf-8', timeout: LOCAL_AUTOMATION_COMMAND_TIMEOUT_MS },
        (error) => {
          finish(error ?? null)
        }
      )
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
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

async function listLocalHermesManager(): Promise<ExternalAutomationManager | null> {
  const [hermesAvailableResult, jobsResult] = await Promise.allSettled([
    isCommandOnPath('hermes'),
    readLocalHermesJobs()
  ])
  const hermesAvailable =
    hermesAvailableResult.status === 'fulfilled' && hermesAvailableResult.value
  const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : []
  const readError = jobsResult.status === 'rejected' ? String(jobsResult.reason) : null
  if (!hermesAvailable && jobs.length === 0 && !readError) {
    return null
  }
  const managerId = 'hermes:local'
  return {
    id: managerId,
    provider: 'hermes',
    label: 'Hermes on this computer',
    targetLabel: 'this computer',
    target: { type: 'local' },
    status: readError ? 'unavailable' : 'available',
    error:
      readError ??
      (hermesAvailable ? null : 'Hermes jobs were found, but the hermes CLI is not on PATH.'),
    canManage: !readError && hermesAvailable,
    jobs: mapHermesJobs(managerId, jobs)
  }
}

async function listLocalOpenClawManager(): Promise<ExternalAutomationManager | null> {
  const [openClawAvailableResult, jobsResult] = await Promise.allSettled([
    isCommandOnPath('openclaw'),
    readLocalOpenClawJobs()
  ])
  const openClawAvailable =
    openClawAvailableResult.status === 'fulfilled' && openClawAvailableResult.value
  const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : []
  const readError = jobsResult.status === 'rejected' ? String(jobsResult.reason) : null
  if (!openClawAvailable && jobs.length === 0 && !readError) {
    return null
  }
  const managerId = 'openclaw:local'
  return {
    id: managerId,
    provider: 'openclaw',
    label: 'OpenClaw on this computer',
    targetLabel: 'this computer',
    target: { type: 'local' },
    status: readError ? 'unavailable' : 'available',
    error:
      readError ??
      (openClawAvailable ? null : 'OpenClaw jobs were found, but the openclaw CLI is not on PATH.'),
    canManage: !readError && openClawAvailable,
    jobs: mapOpenClawJobs(managerId, jobs)
  }
}

function remoteRelayErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('-32601') || /method not found/i.test(message)) {
    return 'Remote relay does not support external automation management. Reconnect the SSH target to deploy the latest relay.'
  }
  return message
}

async function listRemoteHermesManager(target: SshTarget): Promise<ExternalAutomationManager> {
  return listRemoteManager(target, 'hermes')
}

async function listRemoteOpenClawManager(target: SshTarget): Promise<ExternalAutomationManager> {
  return listRemoteManager(target, 'openclaw')
}

async function listRemoteManager(
  target: SshTarget,
  provider: ExternalAutomationProvider
): Promise<ExternalAutomationManager> {
  const providerLabel = provider === 'hermes' ? 'Hermes' : 'OpenClaw'
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
      jobs:
        provider === 'hermes'
          ? mapHermesJobs(managerProviderId, result.jobs ?? [])
          : mapOpenClawJobs(managerProviderId, result.jobs ?? [])
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

export async function listExternalAutomationManagers(
  store: Store
): Promise<ExternalAutomationManager[]> {
  const [localHermes, localOpenClaw, remote] = await Promise.all([
    listLocalHermesManager(),
    listLocalOpenClawManager(),
    Promise.all(
      store
        .getSshTargets()
        .flatMap((target) => [listRemoteHermesManager(target), listRemoteOpenClawManager(target)])
    )
  ])
  return [
    ...(localHermes ? [localHermes] : []),
    ...(localOpenClaw ? [localOpenClaw] : []),
    ...remote
  ]
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
  if (input.provider !== 'hermes') {
    return {
      managerId: input.managerId,
      provider: input.provider,
      target: input.target,
      jobId: input.jobId,
      page,
      pageSize,
      total: 0,
      runs: []
    }
  }
  if (input.target.type === 'local') {
    const result = await readHermesCronOutputRunsPage(input.jobId, { page, pageSize })
    return {
      managerId: input.managerId,
      provider: input.provider,
      target: input.target,
      jobId: input.jobId,
      page,
      pageSize,
      total: result.total,
      runs: mapHermesJobs(input.managerId, [{ id: input.jobId, runs: result.runs }])[0]?.runs ?? []
    }
  }
  const mux = getActiveMultiplexer(input.target.connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error(`SSH target "${input.target.connectionId}" is not connected.`)
  }
  const result = (await mux.request('externalAutomations.runs', {
    provider: input.provider,
    jobId: input.jobId,
    page,
    pageSize
  })) as { total?: number; runs?: unknown[] }
  return {
    managerId: input.managerId,
    provider: input.provider,
    target: input.target,
    jobId: input.jobId,
    page,
    pageSize,
    total: typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : 0,
    runs:
      mapHermesJobs(input.managerId, [{ id: input.jobId, runs: result.runs ?? [] }])[0]?.runs ?? []
  }
}

function hermesCommandForAction(action: ExternalAutomationAction): string {
  switch (action) {
    case 'pause':
      return 'pause'
    case 'resume':
      return 'resume'
    case 'run':
      return 'run'
    case 'delete':
      return 'remove'
  }
}

function openClawCommandForAction(action: ExternalAutomationAction): string {
  switch (action) {
    case 'pause':
      return 'disable'
    case 'resume':
      return 'enable'
    case 'run':
      return 'run'
    case 'delete':
      return 'rm'
  }
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

function hermesCronCreateArgs(input: {
  name: string
  prompt: string
  schedule: string
  workdir: string | null
}): string[] {
  const args = [
    'cron',
    'create',
    input.schedule,
    input.prompt,
    '--name',
    input.name,
    '--deliver',
    'local'
  ]
  if (input.workdir) {
    args.push('--workdir', input.workdir)
  }
  return args
}

function hermesCronEditArgs(
  jobId: string,
  input: {
    name: string
    prompt: string
    schedule: string
    workdir: string | null
  }
): string[] {
  const args = [
    'cron',
    'edit',
    jobId,
    '--schedule',
    input.schedule,
    '--prompt',
    input.prompt,
    '--name',
    input.name
  ]
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
    await runLocalAutomationCommand('hermes', hermesCronCreateArgs(normalized))
    clearHermesCronOutputRunCountCache()
    return
  }
  const mux = getActiveMultiplexer(input.target.connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error(`SSH target "${input.target.connectionId}" is not connected.`)
  }
  await mux.request('externalAutomations.create', {
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
    await runLocalAutomationCommand('hermes', hermesCronEditArgs(input.jobId, normalized))
    clearHermesCronOutputRunCountCache(input.jobId)
    return
  }
  const mux = getActiveMultiplexer(input.target.connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error(`SSH target "${input.target.connectionId}" is not connected.`)
  }
  await mux.request('externalAutomations.update', {
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
  const command =
    input.provider === 'hermes'
      ? hermesCommandForAction(input.action)
      : openClawCommandForAction(input.action)
  if (input.target.type === 'local') {
    await runLocalAutomationCommand(input.provider, ['cron', command, input.jobId])
    if (input.provider === 'hermes') {
      clearHermesCronOutputRunCountCache(input.jobId)
    }
    return
  }
  const mux = getActiveMultiplexer(input.target.connectionId)
  if (!mux || mux.isDisposed()) {
    throw new Error(`SSH target "${input.target.connectionId}" is not connected.`)
  }
  await mux.request('externalAutomations.act', {
    provider: input.provider,
    action: input.action,
    jobId: input.jobId
  })
}
