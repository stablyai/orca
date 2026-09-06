/** Shared by `worktree list` and `worktree ps`, which report host coverage the same way. */
export const WORKTREE_LISTING_SCOPE_NOTES: readonly string[] = [
  'Each row carries the execution host that owns it (`host=`), and the trailing `scope:` line names every host the page covers plus the ones it does not.',
  'A host named under `not covered` may still have workspaces; an empty answer for it is not evidence that it has none. Each is annotated with the flag that reaches it, or marked not selectable from this machine.',
  'The row cap is shared across hosts, so a host whose rows sort last is not starved out of the page.'
]
