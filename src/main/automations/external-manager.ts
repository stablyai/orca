import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type {
  ExternalAutomationAction,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  ExternalAutomationProvider
} from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { getActiveMultiplexer } from '../ipc/ssh'
import { mapHermesJobs, mapOpenClawJobs } from './external-job-mappers'

const execFileAsync = promisify(execFile)
const HERMES_JOBS_FILE = join(homedir(), '.hermes', 'cron', 'jobs.json')
const OPENCLAW_JOBS_FILE = join(homedir(), '.openclaw', 'cron', 'jobs.json')
const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function isCommandOnPath(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(finder, [command], { encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

async function readLocalHermesJobs(): Promise<unknown[]> {
  if (!existsSync(HERMES_JOBS_FILE)) {
    return []
  }
  const content = await readFile(HERMES_JOBS_FILE, 'utf-8')
  const parsed = JSON.parse(content) as unknown
  return Array.isArray(parsed) ? parsed : []
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
    await execFileAsync(input.provider, ['cron', command, input.jobId], { encoding: 'utf-8' })
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
