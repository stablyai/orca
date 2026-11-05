export const WORKTREE_LISTING_SCOPE_NOTES: readonly string[] = [
  'Each row carries the execution host that owns it (`host=`), and the trailing `scope:` line names every host the page covers plus the ones it does not.',
  'A host named under `not covered` may still have workspaces; an empty answer for it is not evidence that it has none. A paired server is annotated with the `--environment` flag that reaches it; this machine and its SSH targets are reached through the same runtime, so no flag selects them.',
  'The row cap is shared across hosts, so a host whose rows sort last is not starved out of the page.'
]
