import {
  describeProcessInspectionError,
  inspectPtyProcess,
  type PtyProcessInspectionSource,
  type PtyProcessLivenessEvidence
} from './pty-process-inspection'
import {
  DEFAULT_LIVE_TTL_MS,
  DEFAULT_UNAVAILABLE_BACKOFF_BASE_MS,
  DEFAULT_UNAVAILABLE_BACKOFF_MAX_MS,
  maxConcurrentProbes,
  maxConcurrentUnscopedProbes,
  processEvidenceKey
} from './pty-process-liveness-broker-state'
import type {
  PtyProcessEvidenceEntry,
  PtyProcessLivenessBrokerOptions
} from './pty-process-liveness-broker-types'
import { waitForPtyProcessProbe } from './pty-process-liveness-broker-wait'
export type { PtyProcessLivenessBrokerOptions } from './pty-process-liveness-broker-types'
export type {
  PtyProcessInspectionSource,
  PtyProcessLivenessEvidence
} from './pty-process-inspection'
export class PtyProcessLivenessBroker {
  private readonly entries = new Map<string, PtyProcessEvidenceEntry>()
  private readonly now: () => number
  private activeProbeCount = 0
  private activeUnscopedProbeCount = 0
  constructor(private readonly options: PtyProcessLivenessBrokerOptions) {
    this.now = options.now ?? Date.now
  }
  inspect(args: {
    source: PtyProcessInspectionSource
    ptyId: string
    identity: string
    freshness?: number
    reuseSettled?: boolean
    deadline?: number
    waitForSettlement?: boolean
    owningInventoryObservedPty?: boolean
    consumerId?: string
  }): Promise<PtyProcessLivenessEvidence> {
    const freshness = args.freshness ?? 0
    const waitMs = args.waitForSettlement
      ? null
      : Math.max(
          0,
          Math.min(
            this.options.timeoutMs,
            args.deadline === undefined ? this.options.timeoutMs : args.deadline - this.now()
          )
        )
    const existing = this.entries.get(args.ptyId)
    if (existing?.source === args.source && existing.identity === args.identity) {
      this.rememberConsumer(existing, args.consumerId)
    }
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      args.owningInventoryObservedPty === true
    ) {
      existing.owningInventoryObservedPty = true
      if (existing.evidence?.status === 'exited') {
        this.storeUnverifiable(existing, 'owning inventory re-observed PTY')
      }
    }
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      freshness >= existing.freshness &&
      !existing.probe &&
      args.owningInventoryObservedPty !== true
    ) {
      existing.owningInventoryObservedPty = false
    }
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      existing.probe &&
      existing.freshness < freshness
    ) {
      if (waitMs === 0) {
        return Promise.resolve({
          status: 'unverifiable',
          reason: 'process inspection timed out'
        })
      }
      return this.waitForProbe(args.ptyId, existing, waitMs).then(() =>
        existing.probe
          ? { status: 'unverifiable', reason: 'process inspection timed out' }
          : this.inspect(args)
      )
    }
    if (
      existing?.source === args.source &&
      existing.identity === args.identity &&
      existing.freshness >= freshness
    ) {
      if (existing.probe) {
        return !args.waitForSettlement && existing.timedOut
          ? Promise.resolve({ status: 'unverifiable', reason: 'process inspection timed out' })
          : waitMs === 0
            ? Promise.resolve({
                status: 'unverifiable',
                reason: 'process inspection timed out'
              })
            : this.waitForProbe(args.ptyId, existing, waitMs)
      }
      if (args.reuseSettled !== false && existing.evidence && existing.expiresAt > this.now()) {
        return Promise.resolve(existing.evidence)
      }
    }
    if (waitMs === 0) {
      return Promise.resolve({ status: 'unverifiable', reason: 'process inspection timed out' })
    }
    const unscopedProbe = args.consumerId === undefined
    if (
      this.activeProbeCount >= maxConcurrentProbes(this.options) ||
      (unscopedProbe && this.activeUnscopedProbeCount >= maxConcurrentUnscopedProbes(this.options))
    ) {
      return Promise.resolve({
        status: 'unverifiable',
        reason: 'process inspection capacity unavailable'
      })
    }

    const failureCount =
      existing?.source === args.source && existing.identity === args.identity
        ? existing.failureCount
        : 0
    const entry: PtyProcessEvidenceEntry = {
      source: args.source,
      identity: args.identity,
      unscopedProbe,
      consumerIds: new Set(args.consumerId ? [args.consumerId] : []),
      hasUnscopedConsumer: args.consumerId === undefined,
      freshness,
      owningInventoryObservedPty: args.owningInventoryObservedPty === true,
      failureCount,
      evidence: null,
      expiresAt: 0,
      timedOut: false,
      probe: null
    }
    this.activeProbeCount += 1
    if (unscopedProbe) {
      this.activeUnscopedProbeCount += 1
    }
    const probe = inspectPtyProcess(args.source, args.ptyId)
      .then((evidence) => {
        const reconciled =
          evidence.status === 'exited' && entry.owningInventoryObservedPty
            ? {
                status: 'unverifiable' as const,
                reason: 'owning inventory re-observed PTY'
              }
            : evidence
        if (this.entries.get(args.ptyId) !== entry) {
          return reconciled
        }
        entry.probe = null
        entry.timedOut = false
        entry.evidence = reconciled
        if (reconciled.status === 'unverifiable') {
          entry.failureCount += 1
          entry.expiresAt = this.now() + this.unavailableBackoffMs(entry.failureCount)
        } else if (reconciled.status === 'live') {
          entry.failureCount = 0
          entry.expiresAt = this.now() + (this.options.liveTtlMs ?? DEFAULT_LIVE_TTL_MS)
        } else {
          entry.failureCount = 0
          entry.expiresAt = Number.POSITIVE_INFINITY
        }
        return reconciled
      })
      .catch((error): PtyProcessLivenessEvidence => {
        if (this.entries.get(args.ptyId) === entry) {
          entry.probe = null
          entry.timedOut = false
          entry.failureCount += 1
          entry.evidence = {
            status: 'unverifiable',
            reason: describeProcessInspectionError(error)
          }
          entry.expiresAt = this.now() + this.unavailableBackoffMs(entry.failureCount)
        }
        try {
          this.options.onInspectionError?.(args.ptyId, error)
        } catch {
          // Diagnostic observers cannot change the authority verdict.
        }
        return { status: 'unverifiable', reason: describeProcessInspectionError(error) }
      })
    entry.probe = probe.finally(() => {
      if (this.entries.get(args.ptyId) === entry) {
        this.activeProbeCount -= 1
        if (entry.unscopedProbe) {
          this.activeUnscopedProbeCount -= 1
        }
      }
    })
    this.entries.set(args.ptyId, entry)
    return this.waitForProbe(args.ptyId, entry, waitMs)
  }
  invalidate(ptyId: string): void {
    const entry = this.entries.get(ptyId)
    if (!entry) {
      return
    }
    this.entries.delete(ptyId)
    if (entry.probe) {
      this.activeProbeCount -= 1
      if (entry.unscopedProbe) {
        this.activeUnscopedProbeCount -= 1
      }
    }
  }
  invalidateAll(): void {
    this.entries.clear()
    this.activeProbeCount = 0
    this.activeUnscopedProbeCount = 0
  }
  retainConsumerEvidence(
    consumerId: string,
    retained: readonly Readonly<{ ptyId: string; identity: string }>[]
  ): void {
    const retainedKeys = new Set(
      retained.map(({ ptyId, identity }) => processEvidenceKey(ptyId, identity))
    )
    for (const [ptyId, entry] of this.entries) {
      if (
        !entry.consumerIds.has(consumerId) ||
        retainedKeys.has(processEvidenceKey(ptyId, entry.identity))
      ) {
        continue
      }
      entry.consumerIds.delete(consumerId)
      if (!entry.hasUnscopedConsumer && entry.consumerIds.size === 0) {
        this.invalidate(ptyId)
      }
    }
  }
  getPendingCount(): number {
    let count = 0
    for (const entry of this.entries.values()) {
      if (entry.probe) {
        count += 1
      }
    }
    return count
  }
  getActiveProbeCount(): number {
    return this.activeProbeCount
  }
  getActiveUnscopedProbeCount(): number {
    return this.activeUnscopedProbeCount
  }
  getEntryCount(): number {
    return this.entries.size
  }
  private waitForProbe(
    ptyId: string,
    entry: PtyProcessEvidenceEntry,
    timeoutMs: number | null
  ): Promise<PtyProcessLivenessEvidence> {
    return waitForPtyProcessProbe(this.entries, ptyId, entry, timeoutMs)
  }
  private unavailableBackoffMs(failureCount: number): number {
    const base = this.options.unavailableBackoffBaseMs ?? DEFAULT_UNAVAILABLE_BACKOFF_BASE_MS
    const max = this.options.unavailableBackoffMaxMs ?? DEFAULT_UNAVAILABLE_BACKOFF_MAX_MS
    return Math.min(max, base * 2 ** Math.max(0, failureCount - 1))
  }
  private rememberConsumer(entry: PtyProcessEvidenceEntry, consumerId: string | undefined): void {
    if (consumerId === undefined) {
      entry.hasUnscopedConsumer = true
    } else {
      entry.consumerIds.add(consumerId)
    }
  }
  private storeUnverifiable(entry: PtyProcessEvidenceEntry, reason: string): void {
    entry.failureCount += 1
    entry.evidence = { status: 'unverifiable', reason }
    entry.expiresAt = this.now() + this.unavailableBackoffMs(entry.failureCount)
  }
}
