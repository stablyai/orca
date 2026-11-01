import {
  buildQuotaContinuationSendMutation,
  isQuotaContinuationSubmissionSettled,
  prepareQuotaContinuationReservation,
  reportQuotaOutcome,
  type NativeQuotaFallbackConfig,
  type NativeQuotaHost
} from './quota-fallback-native-config'
import { verifyNativeQuotaCredential } from './quota-fallback-native-credential'
import { join } from 'node:path'
import type { AgentJournalCursor } from '../../shared/agent-session-journal-identity'
import { QuotaFallbackLedger } from './quota-fallback-ledger'
import {
  NativeQuotaReservationStore,
  type NativeQuotaReservation
} from './quota-fallback-native-store'
import type { NativeQuotaApiCredential } from './quota-fallback-native-auth'
import {
  HELD_QUOTA_CUT_RETRY_INTERVAL_MS,
  HeldQuotaCutRetryTracker,
  type ConfirmedQuotaCut
} from './quota-fallback-journal-cut'

export { HELD_QUOTA_CUT_RETRY_INTERVAL_MS }
export const QUOTA_CONTINUATION_CALLER = 'trusted-local:quota-fallback'

export class NativeQuotaContinuationController {
  private disposed = false
  private readonly reservations: NativeQuotaReservationStore
  private readonly ledger: QuotaFallbackLedger
  private readonly preparing = new Set<string>()
  private readonly active = new Set<string>()
  private readonly observing = new Set<string>()
  private readonly subscriptions = new Map<string, () => void>()
  private readonly heldCuts: HeldQuotaCutRetryTracker
  constructor(
    private readonly deps: {
      stateDirectory: string
      hostId: string
      host(): NativeQuotaHost | null
      config?: NativeQuotaFallbackConfig
      now?: () => number
    }
  ) {
    const directory = join(deps.stateDirectory, 'quota-fallback')
    this.reservations = new NativeQuotaReservationStore(directory)
    this.ledger = new QuotaFallbackLedger(directory)
    this.heldCuts = new HeldQuotaCutRetryTracker(
      () => this.now(),
      () => this.deps.config?.heldRetryIntervalMs
    )
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
  private report(sessionId: string, outcome: string): void {
    reportQuotaOutcome(this.deps.config, sessionId, outcome)
  }
  private async releasePreDispatch(
    sessionId: string,
    reservation: NativeQuotaReservation
  ): Promise<void> {
    this.reservations.release(sessionId, reservation.operationId)
    this.ledger.release(reservation.claimId)
    if (!this.disposed) {
      await this.deps
        .host()
        ?.quotaContinuation.finish(sessionId, () => {})
        .catch(() => {})
    }
  }
  readonly shouldInspect = (sessionId: string, cursor: AgentJournalCursor): boolean =>
    !this.disposed &&
    Boolean(this.deps.config?.enabled) &&
    !this.preparing.has(sessionId) &&
    !this.reservations.read(sessionId) &&
    this.heldCuts.shouldInspect(sessionId, cursor)
  readonly restoreOpenaiSubscription = (sessionId: string): boolean =>
    this.reservations.completedOpenai(sessionId)
  readonly sendAllowed = (sessionId: string, operationId: string, caller: string): boolean => {
    const entry = this.reservations.read(sessionId)
    return (
      !entry ||
      (this.deps.host()?.quotaContinuation.allowed(sessionId, entry.sourceTurnId) === true &&
        caller === QUOTA_CONTINUATION_CALLER &&
        this.active.has(sessionId) &&
        operationId === entry.operationId &&
        entry.phase === 'dispatching')
    )
  }
  readonly deliveryAllowed = (sessionId: string, operationId: string): boolean => {
    const entry = this.reservations.read(sessionId)
    return (
      !entry ||
      (this.deps.host()?.quotaContinuation.allowed(sessionId, entry.sourceTurnId) === true &&
        this.active.has(sessionId) &&
        operationId === entry.operationId &&
        entry.phase === 'dispatching')
    )
  }
  readonly onCut = async (cut: ConfirmedQuotaCut, cursor?: AgentJournalCursor): Promise<void> => {
    const config = this.deps.config
    if (
      this.disposed ||
      !config?.enabled ||
      this.preparing.has(cut.sessionId) ||
      this.reservations.read(cut.sessionId) ||
      this.heldCuts.isHeld(cut.sessionId, cut.turnItemId, cursor)
    ) {
      return
    }
    let dispatchAttempted = false
    this.preparing.add(cut.sessionId)
    try {
      const host = this.deps.host()
      const record = host?.deps.store.getRecord(cut.sessionId)
      if (!host || !record || (record.provider !== 'claude' && record.provider !== 'codex')) {
        return
      }
      const prepared = await prepareQuotaContinuationReservation({
        config,
        hostId: this.deps.hostId,
        record: record as typeof record & { provider: 'claude' | 'codex' },
        cut,
        now: () => this.now(),
        isDisposed: () => this.disposed
      })
      if (prepared.kind === 'aborted') {
        return
      }
      if (prepared.kind === 'held') {
        this.heldCuts.hold(cut, cursor)
        if (prepared.outcome) {
          this.report(cut.sessionId, prepared.outcome)
        }
        return
      }
      const { reservation, remainingUsd } = prepared
      const fence = await host.quotaContinuation.reserve(cut, () => {
        if (this.disposed) {
          throw new Error('Quota controller stopped')
        }
        const { claimId: operationId, route, pool, maxDebitUsd } = reservation
        if (
          this.ledger.claim({
            operationId,
            sessionId: cut.sessionId,
            route,
            pool,
            maxDebitUsd,
            remainingUsd
          }) !== 'claimed'
        ) {
          throw new Error('Quota continuation unavailable')
        }
        this.reservations.write(reservation)
      })
      if (fence === null) {
        const pending = this.reservations.read(cut.sessionId)
        if (pending) {
          await this.releasePreDispatch(cut.sessionId, pending)
        }
        this.heldCuts.hold(cut, cursor)
        this.report(cut.sessionId, 'sourceMovedOn')
        return
      }
      if (this.disposed) {
        throw new Error('Quota controller stopped')
      }
      this.heldCuts.delete(cut.sessionId)
      dispatchAttempted = true
      this.subscriptions.set(
        cut.sessionId,
        host.observeJournalPublications(cut.sessionId, () => {
          void this.observe(cut.sessionId)
        })
      )
      this.active.add(cut.sessionId)
      this.reservations.write({ ...reservation, phase: 'dispatching' })
      this.ledger.settle(reservation.claimId, 'unknown')
      const sent = await host.send(
        { callerKey: QUOTA_CONTINUATION_CALLER },
        buildQuotaContinuationSendMutation(cut, reservation.operationId, fence)
      )
      if (!sent.ok) {
        await this.finish(cut.sessionId, reservation)
        return
      }
      this.report(cut.sessionId, 'submitted')
      await this.observe(cut.sessionId)
    } catch {
      const reservation = this.reservations.read(cut.sessionId)
      this.active.delete(cut.sessionId)
      if (!dispatchAttempted) {
        if (reservation) {
          await this.releasePreDispatch(cut.sessionId, reservation).catch(() => {})
        }
        if (!this.disposed) {
          this.heldCuts.hold(cut, cursor)
        }
      } else {
        if (reservation) {
          this.reservations.write({ ...reservation, phase: 'unknown' })
        }
        this.report(cut.sessionId, 'unknown')
      }
    } finally {
      this.preparing.delete(cut.sessionId)
    }
  }
  readonly credentials = async (sessionId: string): Promise<NativeQuotaApiCredential | null> => {
    const entry = this.reservations.read(sessionId)
    if (!entry) {
      return null
    }
    const config = this.deps.config
    const record = this.deps.host()?.deps.store.getRecord(sessionId)
    if (
      !config?.enabled ||
      !record ||
      !this.active.has(sessionId) ||
      entry.phase !== 'dispatching' ||
      !this.deps.host()?.quotaContinuation.allowed(sessionId, entry.sourceTurnId)
    ) {
      throw new Error('Quota continuation ownership is unresolved')
    }
    return verifyNativeQuotaCredential(
      config,
      record,
      entry,
      () => this.now(),
      () => {
        const current = this.reservations.read(sessionId)
        if (
          !this.active.has(sessionId) ||
          current?.operationId !== entry.operationId ||
          current.phase !== 'dispatching' ||
          !this.deps.host()?.quotaContinuation.allowed(sessionId, entry.sourceTurnId)
        ) {
          throw new Error('Quota continuation ownership changed')
        }
      }
    )
  }
  private async observe(sessionId: string): Promise<void> {
    if (this.observing.has(sessionId) || !this.active.has(sessionId)) {
      return
    }
    this.observing.add(sessionId)
    try {
      const host = this.deps.host()
      const reservation = this.reservations.read(sessionId)
      if (!host || !reservation) {
        return
      }
      const snapshot = await host.journalSnapshot(sessionId)
      const settled = isQuotaContinuationSubmissionSettled(
        snapshot.items,
        snapshot.submissions,
        reservation.operationId,
        reservation.sourceTurnId
      )
      if (settled === null) {
        return
      }
      const work = host.currentWork(sessionId)
      if (!work || work.working() || work.owesAnySend() || work.hasActionablePrompt()) {
        return
      }
      if (settled) {
        await this.finish(sessionId, reservation)
      }
    } catch {
      this.report(sessionId, 'reconciliationPending')
    } finally {
      this.observing.delete(sessionId)
    }
  }
  private async finish(sessionId: string, reservation: NativeQuotaReservation): Promise<void> {
    const finished = await this.deps.host()?.quotaContinuation.finish(sessionId, () => {
      this.reservations.write({ ...reservation, phase: 'completed' })
      this.ledger.settle(reservation.claimId, 'completed')
      this.active.delete(sessionId)
    })
    if (finished) {
      this.subscriptions.get(sessionId)?.()
      this.subscriptions.delete(sessionId)
      this.report(sessionId, 'settled')
    }
  }
  dispose(): void {
    this.disposed = true
    this.subscriptions.forEach((unsubscribe) => unsubscribe())
    this.subscriptions.clear()
    this.active.clear()
    this.heldCuts.clear()
  }
}
