/**
 * An external `sftp-server` is started by sshd through the user's login shell, so anything a
 * startup file prints (a banner, a bare title escape) lands where the SFTP VERSION reply belongs.
 * ssh2 then reads the text as a packet header ("Packet length 1111577416 exceeds max length").
 *
 * ssh2 delivers that parse failure through `client.sftp`'s callback only before the session is
 * ready, and destroys the channel itself. So an error tagged here means no SFTP request beyond
 * INIT was ever sent: nothing was written, and another transfer route cannot race this one.
 */

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
