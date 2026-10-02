import {
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import {
  deriveAgentSessionLeaseState,
  type AgentSessionFreeBasis,
  type AgentSessionHostProof
} from '../../../shared/agent-session-lease-state'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_LEASE_TTL_MS,
  type AgentSessionRecordStore
} from '../../runtime/agent-session-record-store'
import { releaseStoredAgentSessionOwnerAfterSurfaceClose } from '../../runtime/agent-session-surface-release-transition'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

const RENEW_INTERVAL_MS = Math.floor(AGENT_SESSION_LEASE_TTL_MS / 3)

type ConvergenceBasis = Exclude<AgentSessionFreeBasis, { kind: 'stored' }>

/**
 * Every tick, each lease the host is not recovering or acquiring either renews or converges. A held
 * owner renews on a fresh identity match. A lease the host can prove free — an exit it watched, a
 * failed attempt of its own, a probe that found the owner dead or a reservation nothing used — gets
 * the one release its writer never landed. Nothing is latched: a failed write is logged and the next tick derives again, until
 * any successful write (this one, a send's acquisition, a restart's reconciliation) moves the lease.
 */
export class StructuredAgentSessionLeaseRenewer {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  /** The tick in flight. Never rejects: the timer path logs renewal failures,
   *  and stopping must not turn one into a teardown failure as well. */
  private inFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: {
      store: Pick<
        AgentSessionRecordStore,
        | 'listRecords'
        | 'getRecord'
        | 'renewLease'
        | 'renewLeases'
        | 'evictProvenDeadOwner'
        | 'transitionHandoff'
      >
      probe: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
      probeMany?: (
        records: readonly AgentSessionRecord[]
      ) => Promise<Map<string, AgentSessionOwnerProbe>>
      /** What the host's memory proves about this record's owner. */
      ownerProof: (record: AgentSessionRecord) => AgentSessionHostProof
      /** Writes the settlement this host's failed attempt for the session could not. */
      landUnsettledAcquisition: (sessionId: string) => Promise<void>
      /** The session's serialize, so a convergence never interleaves an attach or an exit. */
      serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
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
    const candidates: { record: AgentSessionRecord; proof: AgentSessionHostProof }[] = []
    for (const record of this.input.store.listRecords()) {
      const { lease } = record
      // A record parked in recovery has no transport the host can vouch for; renewing it keeps an
      // orphan pid's lease reading as a healthy owner.
      const owned =
        (lease.claimStatus === 'live' && lease.ownerProcess !== null) ||
        lease.claimStatus === 'reserved'
      if (lease.unreconciled || lease.handoffStage === 'recovering' || !owned) {
        continue
      }
      const proof = this.input.ownerProof(record)
      // An acquisition in flight owns its own lease until it ends.
      if (!proof.attemptInFlight) {
        candidates.push({ record, proof })
      }
    }
    const converging: { record: AgentSessionRecord; basis: ConvergenceBasis }[] = []
    const unproven = candidates.filter(({ record, proof }) => {
      if (proof.owner.kind === 'failed-acquisition') {
        // The write that failed, whether it releases the lease or parks it in recovery.
        converging.push({ record, basis: proof.owner })
        return false
      }
      if (proof.owner.kind !== 'watched-exit') {
        return true
      }
      // Memory speaks for this owner; a probe could only say less.
      const state = deriveAgentSessionLeaseState(record.lease, proof)
      if (state.state === 'free' && state.basis.kind !== 'stored') {
        converging.push({ record, basis: state.basis })
      }
      return false
    })
    const probes = await this.probe(unproven.map(({ record }) => record))
    const renewals: {
      sessionId: string
      fence: number
      childProbe: AgentSessionOwnerProbe
      now: number
    }[] = []
    const now = this.input.now()
    for (const { record, proof } of unproven) {
      const probe = probes.get(record.sessionId)
      if (!probe) {
        continue
      }
      if (proof.owner.kind === 'runs') {
        if (!isProvenDeadProbe(probe)) {
          renewals.push({
            sessionId: record.sessionId,
            fence: record.lease.runtimeFence,
            childProbe: probe,
            now
          })
          continue
        }
        // The exit event's handler owns the release; this is the only sign of one that never came.
        this.input.logger.warn('a chat agent the host still runs probed dead', {
          scope: 'lease-renewal',
          sessionId: record.sessionId,
          probe
        })
        continue
      }
      const state = deriveAgentSessionLeaseState(record.lease, {
        ...proof,
        owner: { kind: 'probed', probe }
      })
      if (state.state === 'free' && state.basis.kind === 'probed') {
        converging.push({ record, basis: state.basis })
      } else if (record.lease.claimStatus === 'live') {
        renewals.push({
          sessionId: record.sessionId,
          fence: record.lease.runtimeFence,
          childProbe: probe,
          now
        })
      }
    }
    await this.renew(renewals)
    for (const { record, basis } of converging) {
      await this.converge(record, basis).catch((error: unknown) => {
        this.input.logger.warn('converging a chat lease the host proved free failed', {
          scope: 'lease-convergence',
          sessionId: record.sessionId,
          error
        })
      })
    }
  }

  private async renew(
    renewals: Parameters<AgentSessionRecordStore['renewLeases']>[0]
  ): Promise<void> {
    if (renewals.length === 0) {
      return
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

  /** One write, under the session's serialize, against the exact lease the proof was taken for. */
  private converge(record: AgentSessionRecord, basis: ConvergenceBasis): Promise<void> {
    const { store } = this.input
    const { sessionId } = record
    // Why: an attempt holds the serialize through its spawn; queueing here would stall the tick.
    if (this.input.ownerProof(record).attemptInFlight) {
      return Promise.resolve()
    }
    return this.input.serialize(sessionId, async () => {
      const current = store.getRecord(sessionId)
      // Moved since the proof was taken, or an acquisition began: the next tick derives again.
      if (current?.lease !== record.lease || this.input.ownerProof(current).attemptInFlight) {
        return
      }
      const expectedFence = record.lease.runtimeFence
      if (basis.kind === 'failed-acquisition') {
        await this.input.landUnsettledAcquisition(sessionId)
        return
      }
      if (basis.kind === 'watched-exit') {
        await releaseStoredAgentSessionOwnerAfterSurfaceClose(store, {
          sessionId,
          expectedFence,
          now: this.input.now(),
          exitObservedAt: basis.observedAt,
          ...(basis.reason ? { exitReason: basis.reason } : {})
        })
        return
      }
      await store.evictProvenDeadOwner({
        sessionId,
        expectedFence,
        probe: basis.probe,
        now: this.input.now()
      })
    })
  }

  private async probe(
    records: readonly AgentSessionRecord[]
  ): Promise<Map<string, AgentSessionOwnerProbe>> {
    if (records.length === 0) {
      return new Map()
    }
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
