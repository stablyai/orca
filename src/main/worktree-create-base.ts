type ResolveWorktreeCreateBaseArgs = {
  requestedBaseBranch?: string
  repoWorktreeBaseRef?: string | null
  resolveDefaultBaseRef: () => Promise<string | null>
  isBaseUsable: (baseBranch: string) => Promise<boolean>
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
  // Stale persisted refs fall back to the detected default; usable custom refs stay authoritative.
  return (await args.isBaseUsable(repoWorktreeBaseRef)) ? repoWorktreeBaseRef : defaultBaseRef
}
