/**
 * Resolve branchNameOverride for `orca worktree create`.
 *
 * Directory names are sanitized (including `/` → `-`). The git branch can
 * still keep slashes when the caller supplies `--branch`, or when `--name`
 * itself contains `/` (composer branch mode #6721 / CLI #13011).
 */
export function resolveCliWorktreeCreateBranchNameOverride(args: {
  name: string
  branch: string | undefined
}): string | undefined {
  const explicit = args.branch?.trim()
  if (explicit) {
    return explicit
  }
  return args.name.includes('/') ? args.name : undefined
}
