import { readFile } from 'node:fs/promises'
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
// Unsent days stay bounded when capture keeps failing.
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
    const today = utcDay(this.now())
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
    if (state.days.length > MAX_PENDING_DAYS) {
      state.days.splice(0, state.days.length - MAX_PENDING_DAYS)
    }
    this.state = state
    if (changed) {
      await this.persist(state)
    }
    // Today's row keeps growing; only finished days leave the machine.
    let sent = false
    while (state.days.length > 0 && state.days[0].day < today) {
      const { day, ...counts } = state.days[0]
      if (!(await this.telemetry.capture({ ...counts, provider: this.provider, usage_day: day }))) {
        break
      }
      state.days.shift()
      sent = true
    }
    if (sent) {
      await this.persist(state)
    }
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
    const content = await readIfExists(this.file)
    if (content !== null) {
      const parsed = stateSchema.parse(JSON.parse(content))
      return { state: { baselines: new Map(parsed.baselines), days: parsed.days }, fresh: false }
    }
    const legacy = await readIfExists(this.legacyFile)
    if (legacy === null) {
      return { state: { baselines: new Map(), days: [] }, fresh: true }
    }
    const parsed = legacyStateSchema.parse(JSON.parse(legacy))
    if (parsed.snapshots.some((snapshot) => snapshot.provider !== this.provider)) {
      throw new Error('Invalid agent token usage state')
    }
    const baselines = new Map(
      parsed.snapshots.map((snapshot) => [snapshot.analytics_session_id, countsOf(snapshot)])
    )
    return { state: { baselines, days: [] }, fresh: false }
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
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
