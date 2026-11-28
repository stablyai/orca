type ResolveWorktreeCreateBaseArgs = {
  requestedBaseBranch?: string
  repoWorktreeBaseRef?: string | null
  /** Resolves null when the repo has no default base; a rejection means the lookup itself failed. */
  resolveDefaultBaseRef: () => Promise<string | null>
  isBaseUsable: (baseBranch: string) => Promise<boolean>
  onPersistedBaseSelected?: (baseBranch: string, defaultBaseRef: string) => Promise<void>
  /** Caller-specific remedy for a failed lookup, e.g. naming the CLI flag. */
  explicitBaseHint?: string
}

export async function resolveWorktreeCreateBase(
  args: ResolveWorktreeCreateBaseArgs
): Promise<string | null> {
  if (args.requestedBaseBranch) {
    return args.requestedBaseBranch
  }

  const repoWorktreeBaseRef = args.repoWorktreeBaseRef
  let defaultBaseRef: string | null
  try {
    defaultBaseRef = await args.resolveDefaultBaseRef()
  } catch (cause) {
    if (repoWorktreeBaseRef && (await args.isBaseUsable(repoWorktreeBaseRef))) {
      return repoWorktreeBaseRef
    }
    throw new Error(
      `Could not look up the default base branch for this repo because Git failed or timed out. Try again, or ${args.explicitBaseHint ?? 'pick a base branch explicitly'}.`,
      { cause }
    )
  }
  if (!repoWorktreeBaseRef) {
    return defaultBaseRef
  }
  if (!defaultBaseRef) {
    return (await args.isBaseUsable(repoWorktreeBaseRef)) ? repoWorktreeBaseRef : null
  }
  if (repoWorktreeBaseRef === defaultBaseRef) {
    return repoWorktreeBaseRef
  }
  // Unusable persisted refs fall back to the detected default; usable custom refs stay authoritative.
  if (await args.isBaseUsable(repoWorktreeBaseRef)) {
    try {
      await args.onPersistedBaseSelected?.(repoWorktreeBaseRef, defaultBaseRef)
    } catch {
      // Advisory diagnostics must never block worktree creation.
    }
    return repoWorktreeBaseRef
  }
  return defaultBaseRef
}
