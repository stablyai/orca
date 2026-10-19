import { errorMessage } from './session-scanner-values'

export function isMissingRemoteSessionPathError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true
  }
  // Relay/provider boundaries can preserve only the underlying Node error text.
  return /(?:^|[\s:])(ENOENT|ENOTDIR)(?=[\s:]|$)/.test(errorMessage(error))
}
