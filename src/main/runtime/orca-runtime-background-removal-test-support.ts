import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { RemoveManagedWorktreeOptions } from './runtime-worktree-selection'

type RemovalRuntimePrototype = {
  removeManagedWorktree: (
    selector: string,
    options?: RemoveManagedWorktreeOptions
  ) => Promise<RemoveWorktreeResult>
}

/**
 * Makes `removeManagedWorktree` wait for its background delete, as a current client does, so suites
 * about what the delete does keep asserting its end state. A test can still pass `false`.
 */
export function awaitBackgroundRemovalsInRuntimeTests(prototype: RemovalRuntimePrototype): void {
  const remove = prototype.removeManagedWorktree
  prototype.removeManagedWorktree = function (selector, options = {}) {
    return remove.call(this, selector, { waitForBackgroundRemoval: true, ...options })
  }
}
