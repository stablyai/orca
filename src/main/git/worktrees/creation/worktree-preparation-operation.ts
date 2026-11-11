import {
  WorktreePreparationDisposal,
  type SettledPreparationDiscard
} from './worktree-preparation-disposal'
import type { PreparationRemovalOutcome } from './worktree-preparation-discard'
import { WorktreePreparationLockOwnershipError } from './worktree-preparation-lock'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { getLocalRepoRefMaintenance } from '../../refs/maintenance/local-repo-ref-maintenance'
import {
  WORKTREE_CREATE_PREPARATION_TTL_MS,
  preparationWorkBudget,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'

export { WORKTREE_CREATE_PREPARATION_TTL_MS } from '../worktree-operation-options'

export class WorktreePreparationOperation extends WorktreePreparationDisposal {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  private readonly transferred = Promise.withResolvers<void>()
  private readonly availableUntil = Date.now() + WORKTREE_CREATE_PREPARATION_TTL_MS
  private readonly writers = new Set<Promise<unknown>>()
  private raw: Promise<void> = Promise.resolve()
  private timer?: NodeJS.Timeout
  private workUntil?: number
  private claimed = false
  private retirement?: Promise<void>
  private revoked: PreparationRemovalOutcome = 'revoked'
  private authorityRevoked = false
  private maintenance?: { release: () => void; signal: AbortSignal; finished: boolean }
  private discardCheckout?: (options: GitWorktreeExecOptions) => Promise<PreparationRemovalOutcome>

  constructor(
    private readonly options: GitWorktreeExecOptions,
    private readonly expired: () => void = () => {}
  ) {
    super()
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.controller.signal])
      : this.controller.signal
    this.signal.addEventListener('abort', this.onAbort, { once: true })
    this.schedule()
  }

  private readonly onAbort = (): void => {
    clearTimeout(this.timer)
    this.releaseMaintenanceIfSafe()
    this.expired()
  }

  claim(supersedeMaterialization = true): void {
    this.claimed = true
    if (supersedeMaterialization) {
      this.transferred.resolve()
    }
    this.schedule()
  }

  complete(): void {
    clearTimeout(this.timer)
    this.signal.removeEventListener('abort', this.onAbort)
  }

  setDiscard(
    discard?: (options: GitWorktreeExecOptions) => Promise<PreparationRemovalOutcome>
  ): void {
    if (!this.authorityRevoked || !discard) {
      this.discardCheckout = discard
    }
  }

  get isClaimed(): boolean {
    return this.claimed
  }

  readonly observeChildTermination = (terminated: Promise<void>, writes: boolean): void => {
    if (writes) {
      this.trackWriter(terminated)
    }
  }

  executionOptions(): GitWorktreeExecOptions {
    return {
      ...this.options,
      signal: this.signal,
      canStart: () => this.current() && !this.signal.aborted && this.options.canStart?.() !== false,
      observeChildTermination: (terminated, writes) => {
        this.options.observeChildTermination?.(terminated, writes)
        this.observeChildTermination(terminated, writes)
      }
    }
  }

  trackWriter<T>(work: Promise<T>): Promise<T> {
    this.writers.add(work)
    void work.then(
      () => this.writerEnded(work),
      () => this.writerEnded(work)
    )
    return work
  }

  private writerEnded(work: Promise<unknown>): void {
    this.writers.delete(work)
    this.releaseMaintenanceIfSafe()
  }

  private releaseMaintenanceIfSafe(held = this.maintenance): void {
    if (
      held &&
      this.maintenance === held &&
      (held.finished || held.signal.aborted) &&
      this.writers.size === 0
    ) {
      held.release()
      this.maintenance = undefined
    }
  }

  async withMaintenancePaused<T>(
    run: () => Promise<T>,
    signal: AbortSignal | undefined = this.signal
  ): Promise<T> {
    const acquiring = getLocalRepoRefMaintenance().pause('worktree-prepare')
    const release = await waitForPromiseWithSignal(acquiring, signal).catch((error: unknown) => {
      void acquiring.then(
        (lateRelease) => lateRelease(),
        () => {}
      )
      throw error
    })
    return this.runWithMaintenanceLease(run, release, signal)
  }

  private async runWithMaintenanceLease<T>(
    run: () => Promise<T>,
    release: () => void,
    signal: AbortSignal
  ): Promise<T> {
    if (signal.aborted) {
      release()
      signal.throwIfAborted()
    }
    const held = { release, signal, finished: false }
    this.maintenance = held
    const onAbort = (): void => this.releaseMaintenanceIfSafe(held)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await run()
    } finally {
      held.finished = true
      signal.removeEventListener('abort', onAbort)
      this.releaseMaintenanceIfSafe(held)
    }
  }

  async waitForMaterialization(barrier: Promise<void>): Promise<void> {
    // The losing reaction owns only the settled race, never the checkout's continuation.
    await waitForPromiseWithSignal(Promise.race([barrier, this.transferred.promise]), this.signal)
    this.signal.throwIfAborted()
  }

  run(work: () => Promise<void>, refresh = false): Promise<void> {
    this.raw = this.raw.then(async () => {
      this.signal.throwIfAborted()
      if (refresh && this.claimed) {
        return
      }
      this.workUntil = Date.now() + preparationWorkBudget(this.options, refresh)
      this.schedule()
      try {
        await work()
        await Promise.allSettled(this.writers)
        this.signal.throwIfAborted()
      } catch (error) {
        if (error instanceof WorktreePreparationLockOwnershipError) {
          this.authorityRevoked = true
          this.setDiscard(undefined)
          this.revoked = error.replaced ? 'ownership-lost' : 'revoked'
        }
        this.controller.abort(error)
        throw error
      } finally {
        this.workUntil = undefined
        this.schedule()
      }
    })
    return waitForPromiseWithSignal(this.raw, this.signal)
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.signal.aborted) {
      return
    }
    const until = this.claimed
      ? this.workUntil
      : Math.min(this.availableUntil, this.workUntil ?? this.availableUntil)
    if (until === undefined) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.controller.abort(new Error('The prepared checkout expired.'))
      },
      Math.max(1, until - Date.now())
    )
    this.timer.unref()
  }

  supervise<T>(
    options: GitWorktreeExecOptions,
    work: (options: GitWorktreeExecOptions) => Promise<T>,
    rollback = false
  ): Promise<T> {
    if (!rollback) {
      this.signal.throwIfAborted()
    }
    this.complete()
    this.beginFinalization(rollback)
    this.retirement = undefined
    let eligible = true
    const result = Promise.resolve()
      .then(() =>
        work({
          ...options,
          canStart: () => eligible && this.current() && options.canStart?.() !== false,
          observeChildTermination: (terminated, writes) => {
            options.observeChildTermination?.(terminated, writes)
            this.observeChildTermination(terminated, writes)
          }
        })
      )
      .catch((error: unknown) => {
        if (error instanceof WorktreePreparationLockOwnershipError) {
          this.authorityRevoked = true
          this.setDiscard(undefined)
          this.revoked = error.replaced ? 'ownership-lost' : 'revoked'
        }
        throw error
      })
      .finally(() => {
        eligible = false
      })
    this.raw = result.then(
      () => {},
      () => {}
    )
    return result
  }

  physicalSettlement(): Promise<void> {
    return this.raw
      .catch(() => {})
      .then(async () => {
        await Promise.allSettled(this.writers)
      })
  }

  retire(): Promise<void> {
    if (!this.retirement) {
      this.controller.abort()
      this.retirement = this.physicalSettlement()
    }
    return this.retirement
  }

  protected async physicalDiscard(
    eligible: () => boolean,
    before: () => Promise<boolean>,
    leaseRetirement: AbortSignal
  ): Promise<SettledPreparationDiscard> {
    const discard = this.discardCheckout
    if (!discard) {
      return { status: this.revoked, attempted: false }
    }
    let attempted = false
    // Lease retirement cannot replace the original acquisition's physical settlement.
    const acquiring = getLocalRepoRefMaintenance().pause('worktree-prepare')
    const cleanup = acquiring.then((release) =>
      this.runWithMaintenanceLease(
        async () => {
          if (!eligible() || !(await before()) || !eligible()) {
            return 'skipped' as const
          }
          return discard({
            ...this.options,
            admissionTier: 'background',
            signal: undefined,
            canStart: eligible,
            observeChildTermination: (terminated, writes) => {
              if (writes) {
                attempted = true
              }
              this.observeChildTermination(terminated, writes)
            }
          })
        },
        release,
        leaseRetirement
      )
    )
    const result = await cleanup.then(
      (status): SettledPreparationDiscard => ({ status, attempted }),
      (error: unknown): SettledPreparationDiscard => ({
        status:
          !eligible() && !attempted
            ? 'skipped'
            : error instanceof WorktreePreparationLockOwnershipError
              ? error.replaced
                ? 'ownership-lost'
                : 'revoked'
              : 'failed',
        attempted: attempted || eligible(),
        error
      })
    )
    await Promise.allSettled(this.writers)
    return { ...result, attempted: result.attempted || attempted }
  }
}
