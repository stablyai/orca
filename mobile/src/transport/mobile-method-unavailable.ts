// Same detection shape as isMobileGitUnavailable in mobile-git-status.ts:
// 'forbidden' = method exists but is not mobile-allowlisted on the old
// desktop; 'method_not_found' = desktop predates the method entirely.
export function isMobileMethodUnavailableError(
  code: string | undefined,
  message: string | undefined
): boolean {
  return (
    code === 'forbidden' ||
    code === 'method_not_found' ||
    message?.includes('not available to mobile clients') === true
  )
}
