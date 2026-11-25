/** The owner a replacing spawn stopped. Its binding stays until the replacement's bind swaps it. */
export type ReplacedPaneOwner = {
  ptyId: string
  pane: { worktreeId: string; tabId: string; leafId: string; hostId: string | undefined } | null
  /** A gone process's: its swap clears the incarnation as the retire it stands in for would. */
  dropsIncarnation?: true
}

/** The stopped id is dead whatever its incarnation, so a binding naming it must not be reattached. */
export function excludeReplacedPaneOwner<Owner extends { ptyId: string }>(
  owner: Owner | null,
  replaced: ReplacedPaneOwner | null
): Owner | null {
  return owner && owner.ptyId === replaced?.ptyId ? null : owner
}
