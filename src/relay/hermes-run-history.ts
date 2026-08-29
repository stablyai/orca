import {
  EXTERNAL_AUTOMATION_JOB_ID_PATTERN,
  externalAutomationProvider
} from './external-automation-provider'
import {
  mergeHermesOutputAndSessionRunRefs,
  mergeHermesOutputAndSessionRuns,
  type HermesMergedRunRef,
  type HermesOutputRunRef,
  type HermesSessionRunRef
} from './hermes-run-correlation'
import { readHermesOutputFileRun, readHermesOutputFileRunRefs } from './hermes-output-run-files'
import {
  readHermesSessionDbRunById,
  readHermesSessionDbRunRefs
} from './hermes-session-run-database'

const HERMES_RUN_COUNT_CACHE_TTL_MS = 2000
const HERMES_RUN_COUNT_CACHE_MAX_ENTRIES = 200

type HermesRunCountCacheEntry = {
  promise: Promise<number>
  expiresAt: number
}

export type HermesRunHistorySources = {
  readOutputRefs: (jobId: string) => Promise<HermesOutputRunRef[]>
  readSessionRefs: (jobId: string) => HermesSessionRunRef[]
  readOutputRun: (ref: HermesOutputRunRef) => Promise<unknown>
  readSessionRun: (jobId: string, runId: string) => unknown
}

const DEFAULT_SOURCES: HermesRunHistorySources = {
  readOutputRefs: readHermesOutputFileRunRefs,
  readSessionRefs: readHermesSessionDbRunRefs,
  readOutputRun: readHermesOutputFileRun,
  readSessionRun: readHermesSessionDbRunById
}

function getRawRunId(run: unknown): string {
  if (typeof run === 'object' && run !== null && 'id' in run) {
    return String(run.id)
  }
  return ''
}

function getRawRunTime(run: unknown): number {
  if (typeof run !== 'object' || run === null || !('run_at' in run)) {
    return Number.NaN
  }
  return typeof run.run_at === 'string' ? Date.parse(run.run_at) : Number.NaN
}

export class HermesRunHistory {
  private readonly runCountCache = new Map<string, HermesRunCountCacheEntry>()

  constructor(private readonly sources: HermesRunHistorySources = DEFAULT_SOURCES) {}

  async listRuns(params: Record<string, unknown> = {}): Promise<{
    total: number
    runs: unknown[]
  }> {
    const provider = externalAutomationProvider(params.provider)
    const jobId = params.jobId
    const page =
      typeof params.page === 'number' && Number.isFinite(params.page)
        ? Math.max(1, Math.floor(params.page))
        : 1
    const pageSize =
      typeof params.pageSize === 'number' && Number.isFinite(params.pageSize)
        ? Math.min(100, Math.max(0, Math.floor(params.pageSize)))
        : 25
    if (provider !== 'hermes') {
      return { total: 0, runs: [] }
    }
    if (typeof jobId !== 'string' || !EXTERNAL_AUTOMATION_JOB_ID_PATTERN.test(jobId)) {
      throw new Error('Invalid external automation job ID.')
    }
    if (pageSize === 0) {
      return { total: await this.readRunCount(jobId), runs: [] }
    }
    const runRefs = await this.readRunRefs(jobId)
    const start = (page - 1) * pageSize
    return {
      total: runRefs.length,
      runs: await Promise.all(
        runRefs.slice(start, start + pageSize).map((ref) => this.hydrateRunRef(jobId, ref))
      )
    }
  }

  clearRunCount(jobId?: string): void {
    if (jobId) {
      this.runCountCache.delete(jobId)
      return
    }
    this.runCountCache.clear()
  }

  private async readRunRefs(jobId: string): Promise<HermesMergedRunRef[]> {
    const outputRuns = await this.sources.readOutputRefs(jobId)
    return mergeHermesOutputAndSessionRunRefs(outputRuns, this.sources.readSessionRefs(jobId)).sort(
      (a, b) => {
        const aTime = getRawRunTime(a)
        const bTime = getRawRunTime(b)
        if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
          return bTime - aTime
        }
        return getRawRunId(b).localeCompare(getRawRunId(a))
      }
    )
  }

  private async hydrateRunRef(jobId: string, ref: HermesMergedRunRef): Promise<unknown> {
    const outputRun = ref.output ? await this.sources.readOutputRun(ref.output) : null
    const sessionRun = ref.session ? this.sources.readSessionRun(jobId, ref.session.id) : null
    return (
      mergeHermesOutputAndSessionRuns(
        outputRun ? [outputRun] : [],
        sessionRun ? [sessionRun] : []
      )[0] ??
      outputRun ??
      sessionRun ??
      ref
    )
  }

  private async readRunCount(jobId: string): Promise<number> {
    const now = Date.now()
    const cached = this.runCountCache.get(jobId)
    if (cached && cached.expiresAt > now) {
      return cached.promise
    }
    if (cached) {
      this.runCountCache.delete(jobId)
    }
    this.pruneRunCountCache(now)
    const entry: HermesRunCountCacheEntry = {
      promise: this.readRunRefs(jobId).then((refs) => refs.length),
      expiresAt: Number.POSITIVE_INFINITY
    }
    this.runCountCache.set(jobId, entry)
    try {
      const count = await entry.promise
      entry.expiresAt = Date.now() + HERMES_RUN_COUNT_CACHE_TTL_MS
      return count
    } catch (error) {
      if (this.runCountCache.get(jobId) === entry) {
        this.runCountCache.delete(jobId)
      }
      throw error
    }
  }

  private pruneRunCountCache(now: number): void {
    for (const [jobId, entry] of this.runCountCache) {
      if (entry.expiresAt <= now) {
        this.runCountCache.delete(jobId)
      }
    }
    while (this.runCountCache.size >= HERMES_RUN_COUNT_CACHE_MAX_ENTRIES) {
      const oldestJobId = this.runCountCache.keys().next().value
      if (oldestJobId === undefined) {
        return
      }
      this.runCountCache.delete(oldestJobId)
    }
  }
}
