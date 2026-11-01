import {
  assertBranchPrefixValid,
  getBranchPrefixIssue,
  getBranchPrefixSeparator,
  getBranchPrefixSeparatorIssue,
  normalizeBranchPrefix,
  selectBranchPrefixInput,
  type BranchPrefixSettings
} from '../../shared/branch-prefix'

/** Expose a normalized prefix so callers avoid double-prefixing and invalid slash combinations. */
export function getConfiguredBranchPrefix(
  settings: Parameters<typeof selectBranchPrefixInput>[0] & { branchPrefixSeparator?: string },
  gitUsername: string | null
): string | null {
  const raw = selectBranchPrefixInput(settings, gitUsername)
  const separator = getBranchPrefixSeparator(settings)
  return raw ? normalizeBranchPrefix(raw, separator) || null : null
}

export function computeBranchName(
  sanitizedName: string,
  settings: Parameters<typeof selectBranchPrefixInput>[0] & { branchPrefixSeparator?: string },
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  const separator = getBranchPrefixSeparator(settings)
  return prefix ? `${prefix}${separator}${sanitizedName}` : sanitizedName
}

/** Validate prefix settings early so creation errors identify configuration rather than opaque Git failures. */
export function computeValidatedBranchName(
  sanitizedWorktreeName: string,
  settings: BranchPrefixSettings,
  gitUsername: string | null
): string {
  // Git rejects a ref component ending in .lock; only the branch is rewritten so the folder keeps its name.
  const sanitizedName = sanitizedWorktreeName.replace(/-?\.lock$/, '-lock')
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  if (prefix === null) {
    return sanitizedName
  }
  const separator = getBranchPrefixSeparator(settings)
  if (getBranchPrefixIssue(prefix) !== null || getBranchPrefixSeparatorIssue(separator) !== null) {
    // Git username lookup can return error payloads; skip invalid derived prefixes but reject custom ones.
    if (
      settings.branchPrefix === 'git-username' &&
      getBranchPrefixSeparatorIssue(separator) === null
    ) {
      return sanitizedName
    }
    assertBranchPrefixValid(prefix, separator)
  }
  return `${prefix}${separator}${sanitizedName}`
}
