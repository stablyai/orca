import { randomBytes } from 'node:crypto'

const SFTP_NAMESPACE_MARKER_PREFIX = '.sftp-namespace-'
const SFTP_NAMESPACE_MARKER_PATTERN = /\.sftp-namespace-[0-9a-f]{32}/giu
const MARKER_TOKEN_BYTES = 16

export function createRelayInstallMarkerFileName(): string {
  return `${SFTP_NAMESPACE_MARKER_PREFIX}${randomBytes(MARKER_TOKEN_BYTES).toString('hex')}`
}

export function redactRelayInstallMarkerTokens(value: string): string {
  return value.replace(SFTP_NAMESPACE_MARKER_PATTERN, `${SFTP_NAMESPACE_MARKER_PREFIX}[redacted]`)
}

export function redactRelayInstallMarkerError(error: unknown): void {
  if (!(error instanceof Error)) {
    return
  }
  const redactedMessage = redactRelayInstallMarkerTokens(error.message)
  if (redactedMessage !== error.message) {
    error.message = redactedMessage
  }
  if (error.stack) {
    const redactedStack = redactRelayInstallMarkerTokens(error.stack)
    if (redactedStack !== error.stack) {
      error.stack = redactedStack
    }
  }
}
