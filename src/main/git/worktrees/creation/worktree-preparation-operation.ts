import { WorktreePreparationLockOwnershipError } from './worktree-preparation-lock'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
import { GIT_READ_TIMEOUT_MS } from '../../../../shared/git/commands/git-command-timeout'
import { getLocalRepoRefMaintenance } from '../../refs/maintenance/local-repo-ref-maintenance'
import {
  resolveWorktreeAddTimeoutMs,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000

export function preparationWorkBudget(options: GitWorktreeExecOptions, refresh: boolean): number {
  const checkout = resolveWorktreeAddTimeoutMs()
  const read = options.timeout ?? GIT_READ_TIMEOUT_MS
  // Include old-Git registration and direct-WSL read fallbacks, each with its own child budget.
  return (
    WORKTREE_CREATE_PREPARATION_TTL_MS +
    (refresh ? 9 * (options.timeout ?? checkout) : 6 * read + 7 * checkout)
  )
}

export class WorktreePreparationOperation {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  private readonly transferred = Promise.withResolvers<void>()
  private readonly availableUntil = Date.now() + WORKTREE_CREATE_PREPARATION_TTL_MS
  private readonly writers = new Set<Promise<unknown>>()
  private raw: Promise<void> = Promise.resolve()
  private timer?: NodeJS.Timeout
  private workUntil?: number
  private claimed = false
  private retirement?: Promise<boolean>
  private discardAttempt?: Promise<void>
  private maintenance?: { release: () => void; signal: AbortSignal; finished: boolean }
  private discardCheckout?: (options: GitWorktreeExecOptions) => Promise<void>

  constructor(
    private readonly options: GitWorktreeExecOptions,
    private readonly expired: () => void = () => {}
  ) {
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

  setDiscard(discard?: (options: GitWorktreeExecOptions) => Promise<void>): void {
    this.discardCheckout = discard
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
      canStart: () => !this.signal.aborted && this.options.canStart?.() !== false,
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

  private releaseMaintenanceIfSafe(): void {
    const held = this.maintenance
    if (held && (held.finished || held.signal.aborted) && this.writers.size === 0) {
      held.release()
      this.maintenance = undefined
    }
  }

  async withMaintenancePaused<T>(run: () => Promise<T>, signal = this.signal): Promise<T> {
    const acquiring = getLocalRepoRefMaintenance().pause('worktree-prepare')
    const release = await waitForPromiseWithSignal(acquiring, signal).catch((error: unknown) => {
      void acquiring.then(
        (lateRelease) => lateRelease(),
        () => {}
      )
      throw error
    })
    if (signal.aborted) {
      release()
      signal.throwIfAborted()
    }
    const held = { release, signal, finished: false }
    this.maintenance = held
    const onAbort = (): void => this.releaseMaintenanceIfSafe()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await run()
    } finally {
      held.finished = true
      signal.removeEventListener('abort', onAbort)
      this.releaseMaintenanceIfSafe()
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
          this.setDiscard(undefined)
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

  retire(): Promise<boolean> {
    if (this.retirement) {
      return this.retirement
    }
    this.controller.abort()
    const proof = this.raw
      .catch(() => {})
      .then(async () => {
        await Promise.allSettled(this.writers)
      })
    this.retirement = sharedPromiseSettlementWaiters(proof)
      .wait({
        timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
      })
      .then(
        () => true,
        () => false
      )
    return this.retirement
  }

  discard(): Promise<void> {
    if (!this.discardAttempt) {
      this.discardAttempt = this.discardOnce()
      void this.discardAttempt.catch(() => {
        this.discardAttempt = undefined
      })
    }
    return this.discardAttempt
  }

  private async discardOnce(): Promise<void> {
    if (!(await this.retire())) {
      return
    }
    const discard = this.discardCheckout
    if (!discard) {
      return
    }
    let eligible = true
    const cleanupController = new AbortController()
    const cleanup = this.withMaintenancePaused(
      () =>
        discard({
          ...this.options,
          signal: undefined,
          canStart: () => eligible,
          observeChildTermination: this.observeChildTermination
        }),
      cleanupController.signal
    )
    // A rejection is not physical completion; retries also require all writer receipts.
    const settled = cleanup
      .then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error })
      )
      .then(async (result) => {
        await Promise.allSettled(this.writers)
        return result
      })
    try {
      const result = await sharedPromiseSettlementWaiters(settled).wait({
        timeoutMs: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
        onAbandon: () => {
          eligible = false
          cleanupController.abort()
        }
      })
      if (result.error !== undefined) {
        throw result.error
      }
    } catch (error) {
      if (!eligible) {
        this.retirement = Promise.resolve(false)
        return
      }
      throw error
    } finally {
      eligible = false
    }
  }
}

export async function runStandalonePreparation<T>(
  options: GitWorktreeExecOptions,
  work: (operation: WorktreePreparationOperation) => Promise<T>
): Promise<T> {
  const operation = new WorktreePreparationOperation(options)
  // A direct caller still owns its fetch barrier; only pool handoff supersedes it.
  operation.claim(false)
  let result!: T
  try {
    await operation.run(async () => {
      result = await work(operation)
    })
    return result
  } catch (error) {
    await operation.discard().catch(() => {})
    throw error
  } finally {
    operation.complete()
  }
}
