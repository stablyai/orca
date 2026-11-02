import type { GitWorktreeInfo } from '../../shared/worktree/types'

// Symbol-keyed so it survives row spreads but never JSON or IPC serialization.
export const PROJECT_CHECKOUT_LOCATOR = Symbol('projectCheckoutLocator')

export type ProjectCheckoutMarked = { [PROJECT_CHECKOUT_LOCATOR]?: string }

/** Copy boundaries that rebuild rows field by field keep the scan's proof. */
export function projectCheckoutMark(
  worktree: Pick<GitWorktreeInfo, 'path'> & ProjectCheckoutMarked
): ProjectCheckoutMarked {
  const locator = worktree[PROJECT_CHECKOUT_LOCATOR]
  return locator === undefined ? {} : { [PROJECT_CHECKOUT_LOCATOR]: locator }
}
