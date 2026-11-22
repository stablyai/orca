import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import {
  agentTokenCountsSchema,
  type AgentTokenCounts,
  type AgentTokenProvider
} from '../../../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import type { UsageTelemetryHost } from '../../usage-store-host'
import { UsageCacheSnapshotWriter } from '../../cache/usage-cache-snapshot-writer'
import { getLocalUsageDay } from '../range-query/usage-calendar-range'
import type { AgentTokenDay } from './agent-token-usage'

const DAY = /^\d{4}-\d{2}-\d{2}$/
// Days older than this are neither sent nor remembered, so late growth for them is dropped.
const LOOKBACK_DAYS = 30

const stateSchema = z
  .object({
    schemaVersion: z.literal(2),
    /** First day this reporter may send; earlier history is never reported. */
    startDay: z.string().regex(DAY),
    /** What each recent day's rows have added up to so far. */
    reported: z.array(z.tuple([z.string().regex(DAY), agentTokenCountsSchema]))
  })
  .strict()

type State = { startDay: string; reported: Map<string, AgentTokenCounts> }

const ZERO: AgentTokenCounts = {
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0
}

function combine(
  a: AgentTokenCounts,
  b: AgentTokenCounts,
  op: (x: number, y: number) => number
): AgentTokenCounts {
  return {
    input_tokens: op(a.input_tokens, b.input_tokens),
    output_tokens: op(a.output_tokens, b.output_tokens),
    cached_input_tokens: op(a.cached_input_tokens, b.cached_input_tokens),
    cache_write_input_tokens: op(a.cache_write_input_tokens, b.cache_write_input_tokens)
  }
}

const isZero = (c: AgentTokenCounts): boolean =>
  c.input_tokens === 0 &&
  c.output_tokens === 0 &&
  c.cached_input_tokens === 0 &&
  c.cache_write_input_tokens === 0

function localDay(date: Date): string {
  return getLocalUsageDay(date.toISOString()) ?? date.toISOString().slice(0, 10)
}

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Sends each finished local day's token totals once, then only growth found for it later. */
export class AgentTokenUsageReporter {
  private state: State | null = null
  private readonly writer: UsageCacheSnapshotWriter
  private pending: Promise<void> = Promise.resolve()
  // Memory ahead of disk after a failed write; retried on the next scan even with no new growth.
  private unsaved = false

  constructor(
    private readonly file: string,
    private readonly legacyFile: string,
    private readonly provider: AgentTokenProvider,
    private readonly telemetry: UsageTelemetryHost,
    private readonly now: () => Date = () => new Date()
  ) {
    this.writer = new UsageCacheSnapshotWriter('[agent-token-usage]', () => file)
  }

  report(days: AgentTokenDay[]): Promise<void> {
    const operation = this.pending.then(() => this.publish(days))
    this.pending = operation.catch(() => {})
    return operation
  }

  async flush(): Promise<void> {
    await this.pending
    await this.writer.flush()
  }

  private async publish(days: AgentTokenDay[]): Promise<void> {
    if (!(await this.telemetry.isEnabled())) {
      return
    }
    const today = localDay(this.now())
    const oldest = shiftDay(today, -LOOKBACK_DAYS)
    const state = this.state ?? (await this.load(today))
    this.state = state
    for (const day of state.reported.keys()) {
      if (day < oldest) {
        state.reported.delete(day)
        this.unsaved = true
      }
    }
    await this.saveIfUnsaved(state)

    const due = days
      .filter(({ day }) => day >= state.startDay && day >= oldest && day < today)
      .sort((a, b) => (a.day < b.day ? -1 : 1))
    for (const { day, ...counts } of due) {
      const sent = state.reported.get(day) ?? ZERO
      const growth = combine(counts, sent, (now, before) => Math.max(0, now - before))
      if (isZero(growth)) {
        continue
      }
      if (!(await this.telemetry.capture({ ...growth, provider: this.provider, usage_day: day }))) {
        break
      }
      state.reported.set(day, combine(sent, counts, Math.max))
      this.unsaved = true
    }
    await this.saveIfUnsaved(state)
  }

  private async saveIfUnsaved(state: State): Promise<void> {
    if (!this.unsaved) {
      return
    }
    await this.writer.write(() =>
      JSON.stringify({ schemaVersion: 2, startDay: state.startDay, reported: [...state.reported] })
    )
    this.unsaved = false
  }

  private async load(today: string): Promise<State> {
    const [current, legacy] = await Promise.all([
      readIfExists(this.file),
      // Only the older build's write time matters; an unreadable file must not stop reporting.
      stat(this.legacyFile).then(
        (info) => ({ mtimeMs: info.mtimeMs }),
        () => null
      )
    ])
    const raw = current ? parseJson(current.content) : undefined
    if (isNewerSchema(raw)) {
      // A newer build owns this file; leave it intact and report nothing here.
      throw new Error('Agent token usage state was written by a newer build')
    }
    const parsed = current ? stateSchema.safeParse(raw) : null
    // An older build reports with its own event; start after any day it may have covered.
    const olderBuildRan = legacy !== null && (!current || legacy.mtimeMs > current.mtimeMs)
    if (parsed?.success && !olderBuildRan) {
      return { startDay: parsed.data.startDay, reported: new Map(parsed.data.reported) }
    }
    if (current && !parsed?.success) {
      console.warn('[agent-token-usage] Unreadable token usage state; starting from today')
    }
    this.unsaved = true
    // A first run starts today, so earlier history is never reported.
    return {
      startDay: olderBuildRan ? shiftDay(today, 1) : today,
      reported: parsed?.success ? new Map(parsed.data.reported) : new Map()
    }
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

function isNewerSchema(raw: unknown): boolean {
  return (
    raw !== null &&
    typeof raw === 'object' &&
    'schemaVersion' in raw &&
    typeof raw.schemaVersion === 'number' &&
    raw.schemaVersion > 2
  )
}
