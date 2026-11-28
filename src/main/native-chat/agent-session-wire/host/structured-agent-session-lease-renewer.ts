import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  AGENT_SESSION_LEASE_TTL_MS,
  type AgentSessionRecordStore
} from '../../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

const RENEW_INTERVAL_MS = Math.floor(AGENT_SESSION_LEASE_TTL_MS / 3)

const HELD_CHILD: AgentSessionOwnerProbe = {
  outcome: 'identity-matched',
  matchedOn: ['held-child']
}

function renewable(record: AgentSessionRecord | null): record is AgentSessionRecord {
  return (
    record !== null &&
    !record.lease.unreconciled &&
    record.lease.claimStatus === 'live' &&
    record.lease.ownerProcess !== null &&
    // Recovery has no owned transport; renewing would make an orphan PID appear healthy.
    record.lease.handoffStage !== 'recovering'
  )
}

export class StructuredAgentSessionLeaseRenewer {
  private timer: ReturnType<typeof setInterval> | null = null
  private witness: string | undefined
  private unsubscribe: (() => void) | undefined
  private disposed = false
  private running = false
  /** Never rejects: timer failures are logged and must not also fail teardown. */
  private inFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
      probeMany?: (
        records: readonly AgentSessionRecord[]
      ) => Promise<Map<string, AgentSessionOwnerProbe>>
      holdsLiveChild: (sessionId: string, fence: number) => boolean
      now: () => number
      logger: StructuredAgentSessionLogger
      intervalMs?: number
    }
  ) {}

  start(): void {
    if (this.unsubscribe || this.disposed) {
      return
    }
    this.unsubscribe = this.input.store.onRecordsChanged((ids) => {
      if (!this.witness) {
        this.setWitness(ids.find((id) => renewable(this.input.store.getRecord(id))))
      } else if (ids.includes(this.witness) && !this.keepsWitness()) {
        this.findWitness()
      }
    })
    this.findWitness()
  }

  private keepsWitness(): boolean {
    return this.witness !== undefined && renewable(this.input.store.getRecord(this.witness))
  }

  private findWitness(): void {
    this.setWitness(this.input.store.listLeaseHolders().find(renewable)?.sessionId)
  }

  private setWitness(witness: string | undefined): void {
    this.witness = witness
    if (!witness) {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    } else if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.disposed) {
          return
        }
        if (!this.keepsWitness()) {
          this.findWitness()
        }
        if (this.witness) {
          void this.renewNow()
        }
      }, this.input.intervalMs ?? RENEW_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  /** Join in-flight commits; clearing the timer alone lets writes outlive host teardown. */
  stop(): Promise<void> {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.setWitness(undefined)
    return this.inFlight
  }

  renewNow(): Promise<void> {
    if (this.running || this.disposed) {
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
    const records = this.input.store.listLeaseHolders().filter(renewable)
    if (records.length === 0) {
      return
    }
    // Held children prove ownership even when PID probes lack start-time/token evidence.
    const holds = (record: AgentSessionRecord): boolean =>
      this.input.holdsLiveChild(record.sessionId, record.lease.runtimeFence)
    const held = new Set(records.filter(holds))
    const unheld = records.filter((record) => !held.has(record))
    const probes =
      unheld.length > 0 ? await this.probe(unheld) : new Map<string, AgentSessionOwnerProbe>()
    if (this.disposed) {
      return
    }
    for (const record of held) {
      // Exit during probes invalidates held-child proof.
      if (holds(record)) {
        probes.set(record.sessionId, HELD_CHILD)
      }
    }
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
    if (renewals.length === 0) {
      return
    }
    // Batch healthy renewals; retry superseded entries individually to preserve isolation.
    let results: PromiseSettledResult<AgentSessionRecord>[]
    try {
      const renewed = await this.input.store.renewLeases(renewals)
      results = renewed.map((record) => ({ status: 'fulfilled', value: record }) as const)
    } catch {
      if (this.disposed) {
        return
      }
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

  /** Lease/ownership failures are transient; future ticks or operations retry. */
  private reportFailure(sessionId: string, error: unknown): void {
    this.input.logger.warn('renewing a chat lease failed', {
      scope: 'lease-renewal',
      sessionId,
      error
    })
  }
}
