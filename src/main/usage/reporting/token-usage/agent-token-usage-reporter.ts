import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import {
  agentTokenCountsSchema,
  agentTokenUsageSchema,
  type AgentTokenCounts,
  type AgentTokenUsage
} from '../../../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import type { UsageTelemetryHost } from '../../usage-store-host'
import { UsageCacheSnapshotWriter } from '../../cache/usage-cache-snapshot-writer'
import type { AgentTokenSession } from './agent-token-usage'

const DAY = /^\d{4}-\d{2}-\d{2}$/
// Unsent days older than this are dropped, so a capture that keeps failing stays bounded.
const MAX_PENDING_DAYS = 90
const COUNT_KEYS = [
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens'
] as const

const dayTotalsSchema = agentTokenCountsSchema.extend({ day: z.string().regex(DAY) }).strict()
type DayTotals = z.infer<typeof dayTotalsSchema>

const stateSchema = z
  .object({
    schemaVersion: z.literal(2),
    baselines: z.array(z.tuple([z.string(), agentTokenCountsSchema])),
    days: z.array(dayTotalsSchema)
  })
  .strict()
// Per-session snapshots an earlier build wrote; read once as baselines and left for that build.
const legacyStateSchema = z
  .object({ schemaVersion: z.literal(1), snapshots: z.array(agentTokenUsageSchema) })
  .strict()

type State = { baselines: Map<string, AgentTokenCounts>; days: DayTotals[] }

const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

/** Sends one row per provider and finished UTC day; per-session totals stay on disk as baselines. */
export class AgentTokenUsageReporter {
  private state: State | null = null
  private readonly writer: UsageCacheSnapshotWriter
  private pending: Promise<void> = Promise.resolve()
  // Memory ahead of disk after a failed write; retried on the next scan even with no new growth.
  private unsaved = false

  constructor(
    private readonly file: string,
    private readonly legacyFile: string,
    private readonly provider: AgentTokenUsage['provider'],
    private readonly getSessionIds: (providerSessionIds: readonly string[]) => Promise<string[]>,
    private readonly telemetry: UsageTelemetryHost,
    private readonly now: () => Date = () => new Date()
  ) {
    this.writer = new UsageCacheSnapshotWriter('[agent-token-usage]', () => file)
  }

  report(sessions: AgentTokenSession[]): Promise<void> {
    const operation = this.pending.then(() => this.publish(sessions))
    this.pending = operation.catch(() => {})
    return operation
  }

  async flush(): Promise<void> {
    await this.pending
    await this.writer.flush()
  }

  private async publish(sessions: AgentTokenSession[]): Promise<void> {
    if (!(await this.telemetry.isEnabled())) {
      return
    }
    const rows = sessions.flatMap(({ providerSessionId, ...counts }) => {
      const parsed = agentTokenCountsSchema.safeParse(counts)
      return parsed.success ? [{ providerSessionId, counts: parsed.data }] : []
    })
    const ids = await this.getSessionIds(rows.map((row) => row.providerSessionId))
    if (!(await this.telemetry.isEnabled())) {
      return
    }
    const loaded = this.state ? { state: this.state, fresh: false } : await this.load()
    const { state } = loaded
    const now = this.now()
    const today = utcDay(now)
    let changed = loaded.fresh
    for (const [index, { counts }] of rows.entries()) {
      const id = ids[index]
      const baseline = state.baselines.get(id)
      if (baseline && COUNT_KEYS.every((key) => baseline[key] === counts[key])) {
        continue
      }
      state.baselines.set(id, counts)
      changed = true
      // A first scan only records baselines so existing history is never reported.
      if (!loaded.fresh) {
        addToDay(state, today, baseline, counts)
      }
    }
    const oldestKept = utcDay(new Date(now.getTime() - MAX_PENDING_DAYS * 86_400_000))
    const kept = state.days.filter((entry) => entry.day >= oldestKept)
    if (kept.length !== state.days.length) {
      state.days = kept
      changed = true
    }
    this.state = state
    this.unsaved ||= changed
    await this.saveIfUnsaved(state)
    // Today's row keeps growing; only finished days leave the machine.
    while (state.days.length > 0 && state.days[0].day < today) {
      const { day, ...counts } = state.days[0]
      if (!(await this.telemetry.capture({ ...counts, provider: this.provider, usage_day: day }))) {
        break
      }
      state.days.shift()
      this.unsaved = true
    }
    await this.saveIfUnsaved(state)
  }

  private async saveIfUnsaved(state: State): Promise<void> {
    if (!this.unsaved) {
      return
    }
    await this.persist(state)
    this.unsaved = false
  }

  private persist(state: State): Promise<void> {
    return this.writer.write(() =>
      JSON.stringify({
        schemaVersion: 2,
        baselines: [...state.baselines],
        days: state.days
      })
    )
  }

  private async load(): Promise<{ state: State; fresh: boolean }> {
    const [current, legacy] = await Promise.all([
      readIfExists(this.file),
      readIfExists(this.legacyFile)
    ])
    const legacyBaselines = legacy ? this.parseLegacy(legacy.content) : null
    const parsed = current ? stateSchema.safeParse(parseJson(current.content)) : null
    if (parsed?.success) {
      const state = { baselines: new Map(parsed.data.baselines), days: parsed.data.days }
      // An older build ran since our last save and already reported its growth.
      if (legacy && legacyBaselines && current && legacy.mtimeMs > current.mtimeMs) {
        for (const [id, counts] of legacyBaselines) {
          state.baselines.set(id, maxCounts(state.baselines.get(id), counts))
        }
      }
      return { state, fresh: false }
    }
    // Unreadable state restarts from today rather than stopping reports for good.
    if (current || !legacyBaselines) {
      return { state: { baselines: new Map(), days: [] }, fresh: true }
    }
    return { state: { baselines: legacyBaselines, days: [] }, fresh: false }
  }

  private parseLegacy(content: string): Map<string, AgentTokenCounts> | null {
    const parsed = legacyStateSchema.safeParse(parseJson(content))
    if (!parsed.success || parsed.data.snapshots.some((s) => s.provider !== this.provider)) {
      return null
    }
    return new Map(parsed.data.snapshots.map((s) => [s.analytics_session_id, countsOf(s)]))
  }
}

async function readIfExists(file: string): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return { content, mtimeMs: info.mtimeMs }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function maxCounts(a: AgentTokenCounts | undefined, b: AgentTokenCounts): AgentTokenCounts {
  return a ? countsOf(Object.fromEntries(COUNT_KEYS.map((k) => [k, Math.max(a[k], b[k])]))) : b
}

function countsOf(source: Partial<AgentTokenCounts>): AgentTokenCounts {
  return {
    input_tokens: source.input_tokens ?? 0,
    output_tokens: source.output_tokens ?? 0,
    cached_input_tokens: source.cached_input_tokens ?? 0,
    cache_write_input_tokens: source.cache_write_input_tokens ?? 0
  }
}

// A total that shrank means the session was rewritten; count its new total from zero.
function addToDay(
  state: State,
  day: string,
  baseline: AgentTokenCounts | undefined,
  counts: AgentTokenCounts
): void {
  const shrank = baseline !== undefined && COUNT_KEYS.some((key) => counts[key] < baseline[key])
  let row = state.days.find((entry) => entry.day === day)
  if (!row) {
    row = { day, ...countsOf({}) }
    state.days.push(row)
  }
  for (const key of COUNT_KEYS) {
    row[key] += counts[key] - (shrank || !baseline ? 0 : baseline[key])
  }
}
