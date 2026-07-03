/**
 * Resolve the branch prefix segment (the part before `/`) the configured
 * strategy will prepend, or null when no prefix applies. Exposed so callers can
 * detect a prefix the user already typed (or a generation model leaked) before
 * it gets prepended a second time.
 */
export function getConfiguredBranchPrefix(
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  gitUsername: string | null
): string | null {
  if (settings.branchPrefix === 'git-username') {
    return gitUsername || null
  }
  if (settings.branchPrefix === 'custom' && settings.branchPrefixCustom) {
    return settings.branchPrefixCustom
  }
  return null
}

/**
 * Compute the full branch name by applying the configured prefix strategy.
 */
export function computeBranchName(
  sanitizedName: string,
  settings: { branchPrefix: string; branchPrefixCustom?: string },
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  return prefix ? `${prefix}/${sanitizedName}` : sanitizedName
}
