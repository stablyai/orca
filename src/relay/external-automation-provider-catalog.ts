import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { HERMES_JOBS_FILE, OPENCLAW_JOBS_FILE } from './external-automation-storage-paths'
import {
  externalAutomationProvider,
  type ExternalAutomationProvider
} from './external-automation-provider'
import type { ExternalAutomationCommandRunner } from './external-automation-command-executor'

type HermesRunLister = (params: Record<string, unknown>) => Promise<{
  total: number
  runs: unknown[]
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class ExternalAutomationProviderCatalog {
  constructor(
    private readonly runCommand: ExternalAutomationCommandRunner,
    private readonly listRuns: HermesRunLister
  ) {}

  async listJobs(params?: Record<string, unknown>): Promise<{
    jobs: unknown[]
    hermesAvailable: boolean
    openclawAvailable: boolean
    error: string | null
  }> {
    const provider = externalAutomationProvider(params?.provider)
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

  private async isCommandAvailable(command: string): Promise<boolean> {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    try {
      await this.runCommand(finder, [command], {
        encoding: 'utf-8',
        timeout: 5000
      })
      return true
    } catch {
      return false
    }
  }

  private async readJobs(provider: ExternalAutomationProvider): Promise<unknown[]> {
    const jobsFile = provider === 'hermes' ? HERMES_JOBS_FILE : OPENCLAW_JOBS_FILE
    if (!existsSync(jobsFile)) {
      return []
    }
    const content = await readFile(jobsFile, 'utf-8')
    const parsed = JSON.parse(content) as unknown
    const jobs = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.jobs)
        ? parsed.jobs
        : []
    if (provider !== 'hermes') {
      return jobs
    }
    return Promise.all(
      jobs.map(async (job) => {
        if (!isRecord(job) || typeof job.id !== 'string') {
          return job
        }
        const runsPage = await this.listRuns({
          provider: 'hermes',
          jobId: job.id,
          page: 1,
          pageSize: 0
        })
        return {
          ...job,
          run_count: runsPage.total,
          runs: runsPage.runs
        }
      })
    )
  }
}
