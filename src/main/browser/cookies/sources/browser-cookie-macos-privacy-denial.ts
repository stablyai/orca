// On Windows EPERM is a transient file lock, so only macOS reads it as a privacy (TCC) denial.
export function isMacPrivacyDenial(error: unknown): boolean {
  return (
    process.platform === 'darwin' &&
    error instanceof Error &&
    'code' in error &&
    error.code === 'EPERM'
  )
}
