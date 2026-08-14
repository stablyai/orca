import {
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_LEASE_TTL_MS,
  type AgentSessionRecordStore
} from '../../runtime/agent-session-record-store'

const RENEW_INTERVAL_MS = Math.floor(AGENT_SESSION_LEASE_TTL_MS / 3)

export class StructuredAgentSessionLeaseRenewer {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
      now: () => number
      onRenewed?: (record: AgentSessionRecord) => Promise<void>
      onDeadTuiOwner?: (record: AgentSessionRecord, probe: AgentSessionOwnerProbe) => Promise<void>
      onError?: (input: { sessionId: string; error: unknown }) => void
      intervalMs?: number
    }
  ) {}

  start(): void {
    if (this.timer) {
      return
    }
    this.timer = setInterval(() => void this.renewNow(), this.input.intervalMs ?? RENEW_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async renewNow(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      await Promise.all(
        this.input.store
          .listRecords()
          .filter(
            (record) =>
              !record.lease.unreconciled &&
              record.lease.claimStatus === 'live' &&
              record.lease.ownerProcess !== null
          )
          .map((record) => this.renewRecord(record))
      )
    } finally {
      this.running = false
    }
  }

  private async renewRecord(record: AgentSessionRecord): Promise<void> {
    try {
      const probe = await this.input.probe(record)
      if (
        record.lease.runtimeKind === 'tui' &&
        isProvenDeadProbe(probe) &&
        this.input.onDeadTuiOwner
      ) {
        await this.input.onDeadTuiOwner(record, probe)
        return
      }
      const renewed = await this.input.store.renewLease({
        sessionId: record.sessionId,
        fence: record.lease.runtimeFence,
        childProbe: probe,
        now: this.input.now()
      })
      await this.input.onRenewed?.(renewed)
    } catch (error) {
      this.input.onError?.({ sessionId: record.sessionId, error })
    }
  }
}
