// One eval run on disk: checks, benchmarks and a ledger of every cloud resource created/destroyed.
// Written after every change so a crash still leaves an accurate ledger for the sweeper.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './env'

export type Status = 'pass' | 'fail' | 'partial' | 'not_landed' | 'skipped'
export type Evidence = { kind: 'log' | 'screenshot' | 'video' | 'timing' | 'json'; label: string; path?: string; text?: string }
export type CheckResult = {
  id: string
  status: Status
  detail: string
  evidence: Evidence[]
  timingsMs?: Record<string, number>
  startedAt: string
  durationMs: number
}
export type Resource = {
  kind: 'sandbox' | 'snapshot' | 'stripe_customer' | 'stripe_test_clock' | 'stripe_subscription' | 'ai_gateway_key' | 'other'
  id: string
  label?: string
  createdAt: string
  destroyedAt?: string
  /** For sandboxes: vCPUs and running intervals, for the cost estimate. */
  vcpus?: number
  runningMs?: number
}
export type Benchmark = { name: string; samplesMs: number[]; note?: string }
export type RunFile = {
  runId: string
  startedAt: string
  finishedAt?: string
  target: { controlPlaneUrl: string; billingUrl: string; desktopRef?: string; integrationSha?: string }
  checks: CheckResult[]
  benchmarks: Benchmark[]
  resources: Resource[]
  notes: string[]
}

export class RunState {
  readonly file: RunFile
  readonly path: string
  readonly artifactsDir: string

  constructor(runId: string, target: RunFile['target']) {
    mkdirSync(config.runsDir, { recursive: true })
    this.path = join(config.runsDir, `${runId}.json`)
    this.artifactsDir = join(config.runsDir, runId)
    mkdirSync(this.artifactsDir, { recursive: true })
    this.file = { runId, startedAt: new Date().toISOString(), target, checks: [], benchmarks: [], resources: [], notes: [] }
    this.save()
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.file, null, 2))
  }

  created(resource: Omit<Resource, 'createdAt'>): Resource {
    const row = { ...resource, createdAt: new Date().toISOString() }
    this.file.resources.push(row)
    this.save()
    return row
  }

  destroyed(kind: Resource['kind'], id: string, runningMs?: number): void {
    for (const row of this.file.resources) {
      if (row.kind === kind && row.id === id && !row.destroyedAt) {
        row.destroyedAt = new Date().toISOString()
        if (runningMs !== undefined) {
          row.runningMs = runningMs
        }
      }
    }
    this.save()
  }

  addRunning(kind: Resource['kind'], id: string, ms: number): void {
    const row = this.file.resources.find((r) => r.kind === kind && r.id === id)
    if (row) {
      row.runningMs = (row.runningMs ?? 0) + ms
      this.save()
    }
  }

  record(result: CheckResult): void {
    this.file.checks = this.file.checks.filter((c) => c.id !== result.id)
    this.file.checks.push(result)
    this.save()
  }

  bench(name: string, samplesMs: number[], note?: string): void {
    this.file.benchmarks = this.file.benchmarks.filter((b) => b.name !== name)
    this.file.benchmarks.push({ name, samplesMs, ...(note ? { note } : {}) })
    this.save()
  }

  note(text: string): void {
    this.file.notes.push(text)
    this.save()
  }

  finish(): void {
    this.file.finishedAt = new Date().toISOString()
    this.save()
  }
}

export function loadRuns(): RunFile[] {
  try {
    return readdirSync(config.runsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(config.runsDir, name), 'utf8')) as RunFile)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  } catch {
    return []
  }
}

export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) {
    return null
  }
  const sorted = [...samples].sort((a, b) => a - b)
  // Nearest-rank: the smallest sample with at least p% of samples at or below it.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]!
}
