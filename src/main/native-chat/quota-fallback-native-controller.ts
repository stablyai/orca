import { readVerifiedQuotaBilling } from './quota-fallback-billing-proof'
import { reportQuotaOutcome } from './quota-fallback-native-config'
import type { NativeQuotaFallbackConfig, NativeQuotaHost } from './quota-fallback-native-config'
import { verifyNativeQuotaCredential } from './quota-fallback-native-credential'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { structuredAgentSessionMessageSendMutation } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { latestNativeChatTurnSinceRequest } from '../../shared/native-chat/native-chat-orca-stop-cut'
import { decideQuotaFallback } from './quota-fallback-policy'
import { QuotaFallbackLedger } from './quota-fallback-ledger'
import {
  NativeQuotaReservationStore,
  type NativeQuotaReservation
} from './quota-fallback-native-store'
import type { NativeQuotaApiCredential } from './quota-fallback-native-auth'
import type { ConfirmedQuotaCut } from './quota-fallback-journal-cut'

export const QUOTA_CONTINUATION_CALLER = 'trusted-local:quota-fallback'

export class NativeQuotaContinuationController {
  private disposed = false
  private readonly reservations: NativeQuotaReservationStore
  private readonly ledger: QuotaFallbackLedger
  private readonly preparing = new Set<string>()
  private readonly active = new Set<string>()
  private readonly observing = new Set<string>()
  private readonly subscriptions = new Map<string, () => void>()
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
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
  private report(sessionId: string, outcome: string): void {
    reportQuotaOutcome(this.deps.config, sessionId, outcome)
  }
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
  readonly onCut = async (cut: ConfirmedQuotaCut): Promise<void> => {
    if (
      this.disposed ||
      !this.deps.config?.enabled ||
      this.preparing.has(cut.sessionId) ||
      this.reservations.read(cut.sessionId)
    ) {
      return
    }
    this.preparing.add(cut.sessionId)
    try {
      const host = this.deps.host()
      const record = host?.deps.store.getRecord(cut.sessionId)
      if (!host || !record || (record.provider !== 'claude' && record.provider !== 'codex')) {
        return
      }
      const verified = await readVerifiedQuotaBilling(this.deps.config, { record, cut }, () =>
        this.now()
      )
      if (this.disposed) {
        return
      }
      if (!verified || !verified.billingProof) {
        this.report(cut.sessionId, 'noVerifiedCreditCap')
        return
      }
      if (
        verified.candidates.some(
          (candidate) => candidate.route === 'antigravity-opus' && candidate.available
        )
      ) {
        this.report(cut.sessionId, 'antigravityAdapterUnavailable')
      }
      const decision = decideQuotaFallback({
        enabled: true,
        provider: record.provider,
        billing: verified.billing,
        errorCode: cut.errorCode,
        turnId: cut.turnItemId,
        currentTurnId: cut.turnItemId,
        settled: true,
        pending: false,
        candidates: verified.candidates.filter(
          (candidate) => candidate.route !== 'antigravity-opus'
        ),
        now: this.now()
      })
      if (decision.kind === 'hold') {
        this.report(cut.sessionId, decision.reason)
        return
      }
      const candidate = verified.candidates.find((item) => item.route === decision.route)
      if (decision.route === 'antigravity-opus' || !candidate?.credit) {
        return
      }
      const claimId = `quota-${createHash('sha256')
        .update(JSON.stringify([this.deps.hostId, cut.sessionId, cut.turnItemId]))
        .digest('hex')}`
      const operationId = `${this.now()}-${claimId.slice(6, 38)}`
      const reservation: NativeQuotaReservation = {
        operationId,
        claimId,
        credentialRef: verified.credentialRef,
        sessionId: cut.sessionId,
        sourceTurnId: cut.turnItemId,
        errorCode: cut.errorCode,
        route: decision.route,
        pool: verified.pool,
        maxDebitUsd: candidate.credit.maxDebitUsd,
        phase: 'reserved'
      }
      const fence = await host.quotaContinuation.reserve(cut, () => {
        if (this.disposed) {
          throw new Error('Quota controller stopped')
        }
        const claim = this.ledger.claim({
          operationId: claimId,
          sessionId: cut.sessionId,
          route: decision.route,
          pool: verified.pool,
          maxDebitUsd: candidate.credit!.maxDebitUsd,
          remainingUsd: candidate.credit!.remainingUsd
        })
        if (claim !== 'claimed') {
          throw new Error('Quota continuation already claimed or budget unavailable')
        }
        this.reservations.write(reservation)
      })
      if (fence === null) {
        this.report(cut.sessionId, 'sourceMovedOn')
        return
      }
      if (this.disposed) {
        throw new Error('Quota controller stopped')
      }
      this.active.add(cut.sessionId)
      this.reservations.write({ ...reservation, phase: 'dispatching' })
      this.ledger.settle(claimId, 'unknown')
      this.subscriptions.set(
        cut.sessionId,
        host.observeJournalPublications(cut.sessionId, () => {
          void this.observe(cut.sessionId)
        })
      )
      const sent = await host.send(
        { callerKey: QUOTA_CONTINUATION_CALLER },
        structuredAgentSessionMessageSendMutation({
          sessionId: cut.sessionId,
          clientOperationId: operationId,
          expectedRuntimeFence: fence,
          usageLimitContinuationOfTurnItemId: cut.turnItemId,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: 'Continue where you left off. Preserve existing approvals and do not repeat completed operations.'
              }
            ]
          }
        })
      )
      if (!sent.ok) {
        await this.finish(cut.sessionId, reservation)
        return
      }
      this.report(cut.sessionId, 'submitted')
      await this.observe(cut.sessionId)
    } catch {
      const reservation = this.reservations.read(cut.sessionId)
      if (reservation) {
        this.reservations.write({ ...reservation, phase: 'unknown' })
      }
      this.active.delete(cut.sessionId)
      this.report(cut.sessionId, 'unknown')
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
      const submission = snapshot.submissions.find(
        (value) => value.clientMessageId === reservation.operationId
      )
      if (
        !submission ||
        submission.dispatchState === 'pending' ||
        submission.dispatchState === 'unknown'
      ) {
        return
      }
      const work = host.currentWork(sessionId)
      if (!work || work.working() || work.owesAnySend() || work.hasActionablePrompt()) {
        return
      }
      const latest = latestNativeChatTurnSinceRequest(snapshot.items, snapshot.submissions)
      if (
        submission.dispatchState === 'rejected' ||
        (latest?.verdict && latest.turnItem.itemId !== reservation.sourceTurnId)
      ) {
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
  }
}
