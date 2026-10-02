import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_LEASE_TTL_MS,
  type AgentSessionRecordStore
} from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

const RENEW_INTERVAL_MS = Math.floor(AGENT_SESSION_LEASE_TTL_MS / 3)

export class StructuredAgentSessionLeaseRenewer {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  /** The tick in flight. Never rejects: the timer path logs renewal failures,
   *  and stopping must not turn one into a teardown failure as well. */
  private inFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
      probeMany?: (
        records: readonly AgentSessionRecord[]
      ) => Promise<Map<string, AgentSessionOwnerProbe>>
      now: () => number
      logger: StructuredAgentSessionLogger
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

  /** Clearing the interval only stops the NEXT tick. A tick already past its guard still has a
   *  store transaction to commit, so a stop that returned before it landed would let the write
   *  outlive whatever tore the host down. */
  stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return this.inFlight
  }

  renewNow(): Promise<void> {
    if (this.running) {
      return this.inFlight
    }
    this.running = true
    const attempt = this.renewOnce().finally(() => {
      this.running = false
    })
    this.inFlight = attempt.then(
      () => undefined,
      () => undefined
    )
    return attempt
  }

  private async renewOnce(): Promise<void> {
    const records = this.input.store.listRecords().filter(
      (record) =>
        !record.lease.unreconciled &&
        record.lease.claimStatus === 'live' &&
        record.lease.ownerProcess !== null &&
        // A record parked in recovery has no transport the host can vouch for; renewing it
        // keeps an orphan pid's lease reading as a healthy owner.
        record.lease.handoffStage !== 'recovering'
    )
    const probes = await this.probe(records)
    const renewals: {
      sessionId: string
      fence: number
      childProbe: AgentSessionOwnerProbe
      now: number
    }[] = []
    const now = this.input.now()
    for (const record of records) {
      const probe = probes.get(record.sessionId)
      if (!probe) {
        continue
      }
      renewals.push({
        sessionId: record.sessionId,
        fence: record.lease.runtimeFence,
        childProbe: probe,
        now
      })
    }
    // One transaction for every renewal on the healthy path. If one renewal is superseded,
    // retrying individually preserves isolation.
    let results: PromiseSettledResult<AgentSessionRecord>[]
    try {
      const renewed = await this.input.store.renewLeases(renewals)
      results = renewed.map((record) => ({ status: 'fulfilled', value: record }) as const)
    } catch {
      results = await Promise.allSettled(
        renewals.map((renewal) => this.input.store.renewLease(renewal))
      )
    }
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const renewal = renewals[index]
        if (renewal) {
          this.reportFailure(renewal.sessionId, result.reason)
        }
      }
    })
  }

  private async probe(
    records: readonly AgentSessionRecord[]
  ): Promise<Map<string, AgentSessionOwnerProbe>> {
    try {
      if (this.input.probeMany) {
        return await this.input.probeMany(records)
      }
      const settled = await Promise.allSettled(records.map((record) => this.input.probe(record)))
      const probes = new Map<string, AgentSessionOwnerProbe>()
      for (const [index, result] of settled.entries()) {
        const record = records[index]
        if (result.status === 'fulfilled') {
          probes.set(record.sessionId, result.value)
        } else {
          this.reportFailure(record.sessionId, result.reason)
        }
      }
      return probes
    } catch (error) {
      for (const record of records) {
        this.reportFailure(record.sessionId, error)
      }
      return new Map()
    }
  }

  /** Lease and ownership failures are transient: the next tick, attach or send retries them. */
  private reportFailure(sessionId: string, error: unknown): void {
    this.input.logger.warn('renewing a chat lease failed', {
      scope: 'lease-renewal',
      sessionId,
      error
    })
  }
}
