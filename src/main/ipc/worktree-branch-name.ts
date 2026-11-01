import {
  assertBranchPrefixValid,
  getBranchPrefixIssue,
  normalizeBranchPrefix,
  selectBranchPrefixInput,
  type BranchPrefixSettings
} from '../../shared/branch-prefix'

/** Expose a normalized prefix so callers avoid double-prefixing and invalid slash combinations. */
export function getConfiguredBranchPrefix(
  settings: Parameters<typeof selectBranchPrefixInput>[0],
  gitUsername: string | null
): string | null {
  const raw = selectBranchPrefixInput(settings, gitUsername)
  return raw ? normalizeBranchPrefix(raw) || null : null
}

export function computeBranchName(
  sanitizedName: string,
  settings: Parameters<typeof selectBranchPrefixInput>[0],
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  return prefix ? `${prefix}/${sanitizedName}` : sanitizedName
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
  if (getBranchPrefixIssue(prefix) !== null) {
    // Git username lookup can return error payloads; skip invalid derived prefixes but reject custom ones.
    if (settings.branchPrefix === 'git-username') {
      return sanitizedName
    }
    assertBranchPrefixValid(prefix)
  }
  return `${prefix}/${sanitizedName}`
}
