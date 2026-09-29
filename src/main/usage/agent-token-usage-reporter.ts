import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  agentTokenCountsSchema,
  agentTokenUsageSchema,
  type AgentTokenUsage
} from '../../shared/telemetry-agent-token-usage-schema'
import { isTelemetryEnabled, track } from '../telemetry/client'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import type { AgentTokenSession } from './agent-token-usage'

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshots: z.array(agentTokenUsageSchema)
  })
  .strict()

/** Cumulative snapshots: consumers select the highest revision per provider/session, never sum retries. */
export class AgentTokenUsageReporter {
  private snapshots: Map<string, AgentTokenUsage> | null = null
  private readonly sent = new Map<string, number>()
  private readonly writer: UsageCacheSnapshotWriter
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly provider: AgentTokenUsage['provider'],
    private readonly getSessionId: (providerSessionId: string) => Promise<string>
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
    if (!isTelemetryEnabled()) {
      return
    }
    const previous = this.snapshots ?? (await this.load())
    const next = new Map(previous)
    let changed = false
    for (const { providerSessionId, ...counts } of sessions) {
      if (!isTelemetryEnabled()) {
        return
      }
      const parsed = agentTokenCountsSchema.safeParse(counts)
      if (!parsed.success) {
        continue
      }
      const id = await this.getSessionId(providerSessionId)
      const existing = next.get(id)
      if (
        existing &&
        existing.input_tokens === counts.input_tokens &&
        existing.output_tokens === counts.output_tokens &&
        existing.cached_input_tokens === counts.cached_input_tokens &&
        existing.cache_write_input_tokens === counts.cache_write_input_tokens
      ) {
        continue
      }
      next.set(
        id,
        agentTokenUsageSchema.parse({
          ...parsed.data,
          provider: this.provider,
          analytics_session_id: id,
          revision: (existing?.revision ?? 0) + 1
        })
      )
      changed = true
    }
    // Persist revisions before capture so a restart can only retry the same snapshot or a newer one.
    if (changed) {
      await this.writer.write(() =>
        JSON.stringify({ schemaVersion: 1, snapshots: [...next.values()] })
      )
    }
    this.snapshots = next
    for (const snapshot of next.values()) {
      if (this.sent.get(snapshot.analytics_session_id) === snapshot.revision) {
        continue
      }
      if (!track('agent_token_usage', snapshot)) {
        break
      }
      this.sent.set(snapshot.analytics_session_id, snapshot.revision)
    }
  }

  private async load(): Promise<Map<string, AgentTokenUsage>> {
    let content: string
    try {
      content = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return new Map()
      }
      throw error
    }
    const state = stateSchema.parse(JSON.parse(content))
    const snapshots = new Map(
      state.snapshots.map((snapshot) => [snapshot.analytics_session_id, snapshot])
    )
    if (
      snapshots.size !== state.snapshots.length ||
      state.snapshots.some((snapshot) => snapshot.provider !== this.provider)
    ) {
      throw new Error('Invalid agent token usage state')
    }
    return snapshots
  }
}
