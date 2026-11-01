import { requestGiteaJsonWithHeaders } from './client'
import type { GiteaRepoRef, LocalGitExecOptions } from './repository-ref'

const PAGE_LIMIT = 50
const MAX_PAGES = 5

export type GiteaPipelineJob = {
  id: number
  runId?: number
  name: string
  stage: string
  status: string
  webUrl: string
  duration: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function listedRecords(value: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord)
  }
  if (!isRecord(value)) {
    return []
  }
  const nested = value[key]
  return Array.isArray(nested) ? nested.filter(isRecord) : []
}

function emptyJobs(): GiteaPipelineJob[] {
  return []
}

function emptyRecords(): Record<string, unknown>[] {
  return []
}

function repoResource(repo: GiteaRepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}${suffix}`
}

function httpStatus(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  const match = /HTTP (\d{3})/.exec(message)
  if (!match) {
    return null
  }
  const status = Number(match[1])
  return Number.isInteger(status) ? status : null
}

function durationSeconds(record: Record<string, unknown>): number | null {
  const started = Date.parse(readString(record, 'started_at'))
  const completed = Date.parse(readString(record, 'completed_at'))
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return null
  }
  return Math.round((completed - started) / 1000)
}

async function readPage(
  repo: GiteaRepoRef,
  path: string,
  searchParams: Record<string, string | number>
): Promise<{ missing: boolean; data: unknown }> {
  try {
    const response = await requestGiteaJsonWithHeaders<unknown>(repo, path, {
      searchParams,
      allowNotFound: true
    })
    return { missing: false, data: response.data }
  } catch (error) {
    if (httpStatus(error) === 404) {
      return { missing: true, data: null }
    }
    throw error
  }
}

async function readListedRecords(
  repo: GiteaRepoRef,
  path: string,
  listKey: string,
  searchParams: Record<string, string | number>
): Promise<{ missing: boolean; records: Record<string, unknown>[] }> {
  const records: Record<string, unknown>[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await readPage(repo, path, { ...searchParams, page, limit: PAGE_LIMIT })
    if (response.missing) {
      return { missing: true, records: [] }
    }
    const pageRecords = listedRecords(response.data, listKey)
    records.push(...pageRecords)
    if (pageRecords.length < PAGE_LIMIT) {
      break
    }
  }
  return { missing: false, records }
}

function mapActionJob(
  run: Record<string, unknown>,
  job: Record<string, unknown>
): GiteaPipelineJob | null {
  const id = readNumber(job, 'id')
  const runId = readNumber(run, 'id')
  const name = readString(job, 'name')
  if (id === null || runId === null || !name) {
    return null
  }
  return {
    id,
    runId,
    name,
    stage: readString(run, 'name'),
    status: readString(job, 'status') || readString(job, 'conclusion'),
    webUrl: readString(job, 'html_url') || readString(job, 'url'),
    duration: durationSeconds(job)
  }
}

function statusCovered(jobs: GiteaPipelineJob[], context: string, targetUrl: string): boolean {
  const normalized = context.trim().toLowerCase()
  return jobs.some((job) => {
    const name = job.name.trim().toLowerCase()
    const stage = job.stage.trim().toLowerCase()
    if (targetUrl && targetUrl === job.webUrl) {
      return true
    }
    if (!normalized || !name) {
      return false
    }
    if (normalized === name) {
      return true
    }
    return stage.length > 0 && normalized.startsWith(`${stage} / ${name}`)
  })
}

function mapCommitStatus(
  status: Record<string, unknown>,
  jobs: GiteaPipelineJob[]
): GiteaPipelineJob | null {
  const name = readString(status, 'context')
  const webUrl = readString(status, 'target_url')
  if (!name || statusCovered(jobs, name, webUrl)) {
    return null
  }
  return {
    // External CI has no Actions job id; 0 keeps log and retry calls off these rows.
    id: 0,
    name,
    stage: '',
    status: readString(status, 'status') || readString(status, 'state'),
    webUrl,
    duration: null
  }
}

async function loadActionJobs(repo: GiteaRepoRef, headSha: string): Promise<GiteaPipelineJob[]> {
  const runs = await readListedRecords(repo, repoResource(repo, '/actions/runs'), 'workflow_runs', {
    head_sha: headSha
  })
  if (runs.missing) {
    return []
  }
  const matching = runs.records.filter((run) => readString(run, 'head_sha') === headSha)
  const jobs: GiteaPipelineJob[] = []
  const seen = new Set<number>()
  for (const run of matching) {
    const runId = readNumber(run, 'id')
    if (runId === null) {
      continue
    }
    const page = await readListedRecords(
      repo,
      repoResource(repo, `/actions/runs/${encodeURIComponent(String(runId))}/jobs`),
      'jobs',
      {}
    )
    if (page.missing) {
      continue
    }
    for (const raw of page.records) {
      const job = mapActionJob(run, raw)
      if (!job || seen.has(job.id)) {
        continue
      }
      seen.add(job.id)
      jobs.push(job)
    }
  }
  return jobs
}

async function loadCommitStatuses(
  repo: GiteaRepoRef,
  headSha: string
): Promise<Record<string, unknown>[]> {
  const page = await readListedRecords(
    repo,
    repoResource(repo, `/commits/${encodeURIComponent(headSha)}/statuses`),
    'statuses',
    {}
  )
  if (page.missing) {
    return []
  }
  return page.records
}

export async function fetchGiteaPipelineJobs(
  repo: GiteaRepoRef,
  headSha: string,
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<GiteaPipelineJob[]> {
  void connectionId
  void localGitOptions
  const sha = headSha.trim()
  if (!sha) {
    return []
  }
  try {
    const jobs = await loadActionJobs(repo, sha).catch(() => emptyJobs())
    const statuses = await loadCommitStatuses(repo, sha).catch(() => emptyRecords())
    const external = statuses.flatMap((status) => {
      const mapped = mapCommitStatus(status, jobs)
      return mapped ? [mapped] : []
    })
    return [...jobs, ...external]
  } catch {
    return []
  }
}
