export function isGitBufferOverflowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const maybeError = error as { code?: unknown; message?: unknown }
  if (maybeError.code === 'ENOBUFS') {
    return true
  }

  return typeof maybeError.message === 'string' && /\bmaxBuffer\b/i.test(maybeError.message)
}
