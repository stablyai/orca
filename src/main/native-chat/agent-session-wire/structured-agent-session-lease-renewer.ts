import { AGENT_SESSION_RETIREMENT_TTL_MS } from '../../../shared/agent-session-retirement'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import { structuredSessionRecoveryIsResolvable } from './structured-agent-session-recovery-resolution'
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
  private readonly recoveryAttempts = new Map<
    string,
    { identity: string; attempts: number; nextAt: number }
  >()

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
      probeMany?: (
        records: readonly AgentSessionRecord[]
      ) => Promise<Map<string, AgentSessionOwnerProbe>>
      now: () => number
      onRecoveryCandidate?: (record: AgentSessionRecord) => Promise<void>
      onRenewed?: (record: AgentSessionRecord) => Promise<void>
      onObserved?: (record: AgentSessionRecord) => void
      onDeadNativeOwner?: (
        record: AgentSessionRecord,
        probe: AgentSessionOwnerProbe
      ) => Promise<void>
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
      await this.recoverCandidates()
      const records = this.input.store.listRecords().filter(
        (record) =>
          !record.lease.unreconciled &&
          record.lease.claimStatus === 'live' &&
          record.lease.ownerProcess !== null &&
          // A native record parked in recovery has no transport the host can vouch
          // for; renewing it keeps an orphan pid's lease reading as a healthy owner.
          !(
            record.lease.runtimeKind === 'native' &&
            (record.lease.handoffStage === 'recovering' ||
              record.lease.handoffStage === 'manual-recovery')
          )
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
        this.input.onObserved?.(record)
        if (!probe) {
          continue
        }
        if (
          record.lease.runtimeKind === 'native' &&
          isProvenDeadProbe(probe) &&
          this.input.onDeadNativeOwner
        ) {
          try {
            await this.input.onDeadNativeOwner(record, probe)
          } catch (error) {
            this.input.onError?.({ sessionId: record.sessionId, error })
          }
          continue
        }
        if (
          record.lease.runtimeKind === 'tui' &&
          isProvenDeadProbe(probe) &&
          this.input.onDeadTuiOwner
        ) {
          try {
            await this.input.onDeadTuiOwner(record, probe)
          } catch (error) {
            this.input.onError?.({ sessionId: record.sessionId, error })
          }
          continue
        }
        renewals.push({
          sessionId: record.sessionId,
          fence: record.lease.runtimeFence,
          childProbe: probe,
          now
        })
      }
      // The store persists the whole record file per transaction, so keep the healthy path to
      // one commit. If one renewal is superseded, retrying individually preserves isolation.
      let results: PromiseSettledResult<AgentSessionRecord>[]
      try {
        const renewed = await this.input.store.renewLeases(renewals)
        await Promise.all(
          renewed.map(async (record) => {
            await this.input.onRenewed?.(record)
          })
        )
        results = renewed.map((record) => ({ status: 'fulfilled', value: record }) as const)
      } catch {
        results = await Promise.allSettled(
          renewals.map(async (renewal) => {
            const renewed = await this.input.store.renewLease(renewal)
            await this.input.onRenewed?.(renewed)
            return renewed
          })
        )
      }
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const renewal = renewals[index]
          if (renewal) {
            this.input.onError?.({ sessionId: renewal.sessionId, error: result.reason })
          }
        }
      })
    } finally {
      this.running = false
    }
  }

  private async recoverCandidates(): Promise<void> {
    const recover = this.input.onRecoveryCandidate
    if (!recover) {
      return
    }
    const records = this.input.store
      .listRecords()
      .filter(
        (record) =>
          !record.lease.unreconciled &&
          (structuredSessionRecoveryIsResolvable(record) ||
            record.lease.settlementRetryRequired ||
            Boolean(record.retirements?.receipts.length))
      )
    const candidates = new Set(records.map((record) => record.sessionId))
    for (const id of this.recoveryAttempts.keys()) {
      if (!candidates.has(id)) {
        this.recoveryAttempts.delete(id)
      }
    }
    await mapWithConcurrency(records, 4, async (record) => {
      const identity = JSON.stringify([
        record.lease.runtimeFence,
        record.lease.ownerProcess,
        record.lease.settlementRetryId,
        record.retirements?.receipts.map((receipt) => [
          receipt.id,
          receipt.capture.incarnation,
          this.input.now() - receipt.observedAt >= AGENT_SESSION_RETIREMENT_TTL_MS
        ])
      ])
      const previous = this.recoveryAttempts.get(record.sessionId)
      const budget =
        previous?.identity === identity ? previous : { identity, attempts: 0, nextAt: 0 }
      if (budget.attempts >= 6 || this.input.now() < budget.nextAt) {
        return
      }
      budget.nextAt =
        this.input.now() + (this.input.intervalMs ?? RENEW_INTERVAL_MS) * 2 ** budget.attempts
      budget.attempts += 1
      this.recoveryAttempts.set(record.sessionId, budget)
      try {
        await recover(record)
      } catch (error) {
        this.input.onError?.({ sessionId: record.sessionId, error })
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
          this.input.onError?.({ sessionId: record.sessionId, error: result.reason })
        }
      }
      return probes
    } catch (error) {
      for (const record of records) {
        this.input.onError?.({ sessionId: record.sessionId, error })
      }
      return new Map()
    }
  }
}
