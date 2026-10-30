/** Login-shell stdout can corrupt SFTP VERSION parsing. Tag only open-callback failures: ssh2 closes before any request beyond INIT, so fallback cannot race remote writes. */

type SftpHandshakeCorruption = Error & { sftpHandshakeCorrupted: true }

/** Call only with an error from `client.sftp`'s open callback. */
export function tagSftpHandshakeCorruption(error: Error): Error {
  // ssh2 sets level 'sftp-protocol' on every SFTP parse failure (doFatalSFTPError).
  if ('level' in error && error.level === 'sftp-protocol') {
    return Object.assign(error, { sftpHandshakeCorrupted: true as const })
  }
  return error
}

export function isSftpHandshakeCorruption(error: unknown): error is SftpHandshakeCorruption {
  return (
    error instanceof Error &&
    'sftpHandshakeCorrupted' in error &&
    error.sftpHandshakeCorrupted === true
  )
}
