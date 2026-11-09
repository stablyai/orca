// Old hosts may refuse methods at the mobile allowlist before dispatch can report method_not_found; accept both.
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
