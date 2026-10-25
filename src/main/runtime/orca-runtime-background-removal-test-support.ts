import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { RemoveManagedWorktreeOptions } from './runtime-worktree-selection'

type RemovalRuntimePrototype = {
  removeManagedWorktree: (
    selector: string,
    options?: RemoveManagedWorktreeOptions
  ) => Promise<RemoveWorktreeResult>
}

/** Await background deletion like current clients so assertions see final state; callers may still pass false. */
export function awaitBackgroundRemovalsInRuntimeTests(prototype: RemovalRuntimePrototype): void {
  const remove = prototype.removeManagedWorktree
  prototype.removeManagedWorktree = function (selector, options = {}) {
    return remove.call(this, selector, { waitForBackgroundRemoval: true, ...options })
  }
}
