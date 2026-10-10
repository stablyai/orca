import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ExternalAutomationManager,
  ExternalAutomationProvider
} from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { mapHermesJobs, mapOpenClawJobs } from './external-job-mappers'
import { readHermesCronOutputRunsPage } from './hermes-cron-output'
import { isExternalAutomationCommandOnPath } from './external-manager-local-command'
import { externalAutomationRelayErrorMessage } from './external-manager-relay'

const HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')
const HERMES_CRON_DIR = join(HERMES_HOME, 'cron')
const HERMES_JOBS_FILE = join(HERMES_CRON_DIR, 'jobs.json')
const OPENCLAW_JOBS_FILE = join(homedir(), '.openclaw', 'cron', 'jobs.json')
const PROVIDER_LABELS: Record<ExternalAutomationProvider, string> = {
  hermes: 'Hermes',
  openclaw: 'OpenClaw'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

export async function listLocalManager(
  provider: ExternalAutomationProvider
): Promise<ExternalAutomationManager | null> {
  const [availableResult, jobsResult] = await Promise.allSettled([
    isExternalAutomationCommandOnPath(provider),
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

export async function listRemoteManager(
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
      error: externalAutomationRelayErrorMessage(error),
      canManage: false,
      jobs: []
    }
  }
}
