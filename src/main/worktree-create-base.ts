type ResolveWorktreeCreateBaseArgs = {
  requestedBaseBranch?: string
  repoWorktreeBaseRef?: string | null
  resolveDefaultBaseRef: () => Promise<string | null>
  isBaseUsable: (baseBranch: string) => Promise<boolean>
  onPersistedBaseSelected?: (baseBranch: string, defaultBaseRef: string) => Promise<void>
}

export async function resolveWorktreeCreateBase(
  args: ResolveWorktreeCreateBaseArgs
): Promise<string | null> {
  if (args.requestedBaseBranch) {
    return args.requestedBaseBranch
  }

  const defaultBaseRef = await args.resolveDefaultBaseRef()
  const repoWorktreeBaseRef = args.repoWorktreeBaseRef
  if (!repoWorktreeBaseRef) {
    return defaultBaseRef
  }
  if (!defaultBaseRef) {
    return (await args.isBaseUsable(repoWorktreeBaseRef)) ? repoWorktreeBaseRef : null
  }
  // Resolving the default already proved matching persisted refs exist.
  if (repoWorktreeBaseRef === defaultBaseRef) {
    return repoWorktreeBaseRef
  }
  // Unusable persisted refs fall back to the detected default; usable custom refs stay authoritative.
  const isUsable = await args.isBaseUsable(repoWorktreeBaseRef)
  if (isUsable) {
    try {
      await args.onPersistedBaseSelected?.(repoWorktreeBaseRef, defaultBaseRef)
    } catch {
      // Advisory diagnostics must never block worktree creation.
    }
    return repoWorktreeBaseRef
  }
  return defaultBaseRef
}
