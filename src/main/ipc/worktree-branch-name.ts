import {
  assertBranchPrefixValid,
  normalizeBranchPrefix,
  selectBranchPrefixInput,
  type BranchPrefixSettings
} from '../../shared/branch-prefix'

/**
 * Resolve the branch prefix segment (the part before `/`) the configured
 * strategy will prepend, or null when no prefix applies. Exposed so callers can
 * detect a prefix the user already typed (or a generation model leaked) before
 * it gets prepended a second time.
 *
 * The returned prefix is normalized (surrounding whitespace/slashes stripped) so
 * a custom value like `team/` cannot produce a `team//name` branch that git
 * check-ref-format rejects.
 */
export function getConfiguredBranchPrefix(
  settings: BranchPrefixSettings,
  gitUsername: string | null
): string | null {
  const raw = selectBranchPrefixInput(settings, gitUsername)
  return raw ? normalizeBranchPrefix(raw) || null : null
}

/**
 * Compute the full branch name by applying the configured prefix strategy.
 */
export function computeBranchName(
  sanitizedName: string,
  settings: BranchPrefixSettings,
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  return prefix ? `${prefix}/${sanitizedName}` : sanitizedName
}

/**
 * Compute a branch name and fail fast when the configured prefix is invalid.
 * Used on worktree-create paths so users get a clear settings hint instead of
 * an opaque git check-ref-format failure.
 */
export function computeValidatedBranchName(
  sanitizedName: string,
  settings: BranchPrefixSettings,
  gitUsername: string | null
): string {
  const prefix = getConfiguredBranchPrefix(settings, gitUsername)
  if (prefix === null) {
    return sanitizedName
  }
  assertBranchPrefixValid(prefix)
  return `${prefix}/${sanitizedName}`
}
