export const WORKTREE_LISTING_SCOPE_NOTES: readonly string[] = [
  'Each row names the server that owns it (`server=` or the `server:` line); `server=unknown` means Orca cannot verify the owner from here and does not guess. The trailing `scope:` line names every host id the page covers plus the ones it does not.',
  'An id named under `not covered` may still have workspaces; an empty answer for it is not evidence that it has none. A saved server is annotated with the `--server` flag that reaches it; this computer and its SSH connections are reached through the answering server, so no flag selects them.',
  'The row cap is shared across hosts, so rows that sort last are not starved out of the page.'
]
