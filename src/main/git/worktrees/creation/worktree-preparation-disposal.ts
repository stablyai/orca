import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from '../worktree-operation-options'
import type { PreparationRemovalOutcome } from './worktree-preparation-discard'

export type SettledPreparationDiscard = {
  status: PreparationRemovalOutcome | 'failed'
  attempted: boolean
  error?: unknown
}
export type PreparationDiscardResult =
  | SettledPreparationDiscard
  | {
      status: 'pending'
      settled: Promise<SettledPreparationDiscard>
    }

export abstract class WorktreePreparationDisposal {
  private discardAttempt?: Promise<void>
  private disposalState:
    | 'owned'
    | 'finalizing'
    | 'pending'
    | 'active'
    | 'parked'
    | 'terminal'
    | 'released' = 'owned'
  private attempts = 0
  private wake?: object
  private disposalOwner?: {
    current: () => boolean
    before: () => Promise<boolean>
    schedule: (work: () => Promise<void>) => Promise<void>
    disposed: () => void
  }

  abstract physicalSettlement(): Promise<void>

  async waitForPhysicalSettlement(onAbandon?: () => void): Promise<boolean> {
    return sharedPromiseSettlementWaiters(this.physicalSettlement())
      .wait({
        timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
        onAbandon
      })
      .then(
        () => true,
        () => false
      )
  }

  protected abstract retire(): Promise<void>
  protected abstract physicalDiscard(
    eligible: () => boolean,
    before: () => Promise<boolean>,
    leaseRetirement: AbortSignal
  ): Promise<SettledPreparationDiscard>
  protected abstract complete(): void

  protected beginFinalization(rollback: boolean): void {
    if (
      !this.current() ||
      (this.disposalState !== 'owned' && !(rollback && this.disposalState === 'finalizing'))
    ) {
      throw new Error('The prepared checkout is no longer available for finalization.')
    }
    this.disposalState = 'finalizing'
  }

  finishFinalization(outcome: 'disposed' | 'pending' | 'failed' = 'failed'): void {
    if (outcome === 'disposed') {
      this.disposalOwner?.disposed()
      this.release()
    } else if (this.disposalState === 'finalizing') {
      if (outcome === 'pending') {
        this.acceptDiscard({
          status: 'pending',
          settled: this.physicalSettlement().then(() => ({ status: 'skipped', attempted: false }))
        })
      } else {
        this.disposalState = 'pending'
      }
    }
  }
  setDisposalOwner(owner: NonNullable<WorktreePreparationDisposal['disposalOwner']>): void {
    this.disposalOwner = owner
  }

  get needsDiscardRetry(): boolean {
    return this.disposalState === 'pending'
  }

  release(): void {
    this.disposalState = 'released'
    this.wake = undefined
    this.complete()
  }

  protected current(): boolean {
    return this.disposalState !== 'released' && this.disposalOwner?.current() !== false
  }

  discard(): Promise<void> {
    if (
      !this.current() ||
      this.disposalState === 'finalizing' ||
      this.disposalState === 'parked' ||
      this.disposalState === 'terminal'
    ) {
      return Promise.resolve()
    }
    if (this.discardAttempt) {
      return this.discardAttempt
    }
    this.disposalState = 'active'
    const run = async (): Promise<void> => this.acceptDiscard(await this.discardOnce())
    const attempt = this.disposalOwner ? this.disposalOwner.schedule(run) : run()
    this.discardAttempt = attempt
    void attempt.then(() => {
      if (this.discardAttempt === attempt) {
        this.discardAttempt = undefined
      }
    })
    return attempt
  }

  private acceptDiscard(result: PreparationDiscardResult): void {
    if (!this.current()) {
      return
    }
    if (result.status !== 'pending') {
      this.finishDiscard(result, false)
      return
    }
    const token = {}
    this.wake = token
    this.disposalState = 'parked'
    void result.settled.then((settled) => {
      if (!this.current() || this.disposalState !== 'parked' || this.wake !== token) {
        return
      }
      this.wake = undefined
      this.finishDiscard(settled, true)
    })
  }

  private finishDiscard(result: SettledPreparationDiscard, wake: boolean): void {
    if (!this.current()) {
      return
    }
    if (result.attempted) {
      this.attempts += 1
    }
    if (result.status === 'removed' || result.status === 'ownership-lost') {
      this.disposalOwner?.disposed()
      this.release()
      return
    }
    if (result.status === 'revoked' || this.attempts >= 3) {
      this.disposalState = 'terminal'
      console.warn(
        '[worktree-create] prepared checkout remains; automatic cleanup stopped',
        result.error
      )
      return
    }
    this.disposalState = 'pending'
    if (wake) {
      void (this.discardAttempt ?? Promise.resolve()).then(() => {
        if (this.current() && this.needsDiscardRetry) {
          void this.discard()
        }
      })
    }
  }

  private async discardOnce(): Promise<PreparationDiscardResult> {
    const retirement = this.retire()
    const retired = await sharedPromiseSettlementWaiters(retirement)
      .wait({
        timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
      })
      .then(
        () => true,
        () => false
      )
    if (!retired) {
      return {
        status: 'pending',
        settled: retirement.then(() => ({ status: 'skipped', attempted: false }))
      }
    }
    let eligible = true
    const leaseRetirement = new AbortController()
    const settled = this.physicalDiscard(
      () => eligible && this.current(),
      () => this.disposalOwner?.before() ?? Promise.resolve(true),
      leaseRetirement.signal
    )
    const result = await sharedPromiseSettlementWaiters(settled)
      .wait({
        timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
        onAbandon: () => {
          eligible = false
          leaseRetirement.abort()
        }
      })
      .catch(() => ({ status: 'pending' as const, settled }))
    eligible = false
    return result
  }
}
