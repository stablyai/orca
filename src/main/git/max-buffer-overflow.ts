export function isMaxBufferOverflowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const maybeError = error as { code?: unknown; message?: unknown }
  if (maybeError.code === 'ENOBUFS') {
    return true
  }

  return typeof maybeError.message === 'string' && /\bmaxBuffer\b/i.test(maybeError.message)
}

export function describeMaxBufferOverflowError(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  return String(error)
}
