import {
  captureWorktreeCheckoutIdentity,
  assertWorktreeCheckoutIdentity
} from './worktree-checkout-identity'
import {
  WorktreeRemovalIncarnationChangedError,
  isWorktreeIncarnationChanged,
  type WorktreeCheckoutIdentity
} from '../../../shared/worktree/removal/worktree-checkout-identity'
import { worktreeCheckoutExists } from './worktree-removal-table'
export { WorktreeRemovalIncarnationChangedError } from '../../../shared/worktree/removal/worktree-checkout-identity'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { readWorktreeMetaForHost } from '../../persistence/host-qualified-worktree-meta'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { errorMessage } from '../../../shared/errors/error-message'

export type ExpectedWorktreeRemoval = {
  worktreeId: string
  instanceId: string
  checkoutIdentity?: WorktreeCheckoutIdentity
}

export class WorktreeRemovalNotStartedError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error), { cause: error })
  }
}

/** Only the removal owner can prove that no destructive step started. */
export class WorktreeRemovalExpectation {
  private destructive = false
  private checkout?: WorktreeCheckoutIdentity
  readonly expected: Readonly<ExpectedWorktreeRemoval>

  constructor(
    private readonly store: RuntimeStore,
    expected: ExpectedWorktreeRemoval,
    private readonly hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
  ) {
    this.expected = Object.freeze({ ...expected })
    this.checkout = expected.checkoutIdentity
      ? Object.freeze({ ...expected.checkoutIdentity })
      : undefined
  }

  check(worktreeId = this.expected.worktreeId): void {
    const meta = readWorktreeMetaForHost(this.store, worktreeId, this.hostId)
    if (
      worktreeId !== this.expected.worktreeId ||
      !this.expected.instanceId ||
      meta?.instanceId !== this.expected.instanceId
    ) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    if (meta.isPinned) {
      throw new Error('The workspace was pinned before deletion; it was left in place.')
    }
  }

  get checkoutIdentity(): WorktreeCheckoutIdentity {
    if (!this.checkout || this.checkout.instanceId !== this.expected.instanceId) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    return this.checkout
  }

  async verifyCheckout(root: string): Promise<void> {
    this.check()
    const checkout = this.checkoutIdentity
    if (checkout.root !== root) {
      throw new WorktreeRemovalIncarnationChangedError()
    }
    await assertWorktreeCheckoutIdentity(checkout)
    this.check()
  }

  /** Resuming after a restart: a checkout Git already deleted proves nothing, but there is nothing
   * left to protect either, so the removal fails with a retry instead of a silent refusal. */
  async verifyResumedCheckout(root: string): Promise<void> {
    this.check()
    try {
      await this.verifyCheckout(root)
    } catch (error) {
      if (isWorktreeIncarnationChanged(error) && !(await worktreeCheckoutExists(root))) {
        throw new Error(
          'The reviewed workspace folder is already gone. Retry deletion to finish cleanup.'
        )
      }
      throw error
    }
  }

  async bindCheckout(root: string, repoPath: string): Promise<void> {
    this.check()
    this.checkout ??= await captureWorktreeCheckoutIdentity(
      root,
      this.expected.instanceId,
      repoPath
    )
    await this.verifyCheckout(root)
  }

  begin(): void {
    this.check()
    this.destructive = true
  }

  joined(): void {
    this.destructive = true
  }

  async run<T>(remove: () => Promise<T>): Promise<T> {
    try {
      this.check()
      return await remove()
    } catch (error) {
      throw this.destructive ? error : new WorktreeRemovalNotStartedError(error)
    }
  }
}
