import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { RelayDispatcher } from './dispatcher'

const execFileAsync = promisify(execFile)
const HERMES_JOBS_FILE = join(homedir(), '.hermes', 'cron', 'jobs.json')
const OPENCLAW_JOBS_FILE = join(homedir(), '.openclaw', 'cron', 'jobs.json')
const EXTERNAL_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

type ExternalProvider = 'hermes' | 'openclaw'
type HermesAction = 'pause' | 'resume' | 'run' | 'delete'

export class ExternalAutomationsHandler {
  constructor(private readonly dispatcher: RelayDispatcher) {
    this.dispatcher.onRequest('externalAutomations.list', (params) => this.listJobs(params))
    this.dispatcher.onRequest('externalAutomations.act', (params) => this.runAction(params))
  }

  private async isCommandAvailable(command: string): Promise<boolean> {
    try {
      await execFileAsync('/bin/sh', ['-lc', `which ${command}`], {
        encoding: 'utf-8',
        timeout: 5000
      })
      return true
    } catch {
      return false
    }
  }

  private async readJobs(provider: ExternalProvider): Promise<unknown[]> {
    const jobsFile = provider === 'hermes' ? HERMES_JOBS_FILE : OPENCLAW_JOBS_FILE
    if (!existsSync(jobsFile)) {
      return []
    }
    const content = await readFile(jobsFile, 'utf-8')
    const parsed = JSON.parse(content) as unknown
    if (Array.isArray(parsed)) {
      return parsed
    }
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { jobs?: unknown }).jobs)
      ? (parsed as { jobs: unknown[] }).jobs
      : []
  }

  private async listJobs(params?: Record<string, unknown>): Promise<{
    jobs: unknown[]
    hermesAvailable: boolean
    openclawAvailable: boolean
    error: string | null
  }> {
    const provider = params?.provider === 'openclaw' ? 'openclaw' : 'hermes'
    const [commandAvailable, jobsResult] = await Promise.allSettled([
      this.isCommandAvailable(provider),
      this.readJobs(provider)
    ])
    const jobs = jobsResult.status === 'fulfilled' ? jobsResult.value : []
    const available = commandAvailable.status === 'fulfilled' && commandAvailable.value
    return {
      jobs,
      hermesAvailable: provider === 'hermes' && available,
      openclawAvailable: provider === 'openclaw' && available,
      error: jobsResult.status === 'rejected' ? String(jobsResult.reason) : null
    }
  }

  private hermesCommand(action: HermesAction): string {
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

  private openClawCommand(action: HermesAction): string {
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

  private async runAction(params: Record<string, unknown> = {}): Promise<{ ok: true }> {
    const provider = params.provider === 'openclaw' ? 'openclaw' : 'hermes'
    const action = params.action
    const jobId = params.jobId
    if (action !== 'pause' && action !== 'resume' && action !== 'run' && action !== 'delete') {
      throw new Error('Unsupported external automation action.')
    }
    if (typeof jobId !== 'string' || !EXTERNAL_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    const command =
      provider === 'hermes' ? this.hermesCommand(action) : this.openClawCommand(action)
    await execFileAsync('/bin/sh', ['-lc', `${provider} cron ${command} ${jobId}`], {
      encoding: 'utf-8',
      timeout: 30_000
    })
    return { ok: true }
  }
}
