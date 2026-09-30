import { normalizeWindowsRemotePath } from './ssh-remote-platform'

/**
 * A path this transfer cannot express to sftp. Callers treat it as "use another transport", never
 * as a transfer failure.
 */
export class UnsupportedSftpPathError extends Error {
  constructor(path: string) {
    super(`Path cannot be addressed over sftp: ${JSON.stringify(path)}`)
    this.name = 'UnsupportedSftpPathError'
  }
}

/**
 * Converts a Windows remote path to the namespace OpenSSH's Windows sftp-server exposes, which
 * roots every drive under `/`: `C:/Users/dev/f` is `/C:/Users/dev/f`, and `pwd` there reports
 * `/C:/Users/dev`.
 */
export function toSftpRemotePath(remotePath: string): string {
  const normalized = normalizeWindowsRemotePath(remotePath)
  if (/^\/[a-zA-Z]:\//.test(normalized)) {
    return normalized
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `/${normalized}`
  }
  // UNC (`//server/share`) and relative paths have no settled mapping in this namespace, and a
  // guess here writes real bytes to the wrong place. Decline instead.
  throw new UnsupportedSftpPathError(remotePath)
}

/**
 * Quotes one argument of an sftp batch line.
 *
 * Escaping is load-bearing, not cosmetic: sftp's batch lexer treats `\` as an escape even inside
 * double quotes, so an unescaped Windows local path `C:\src\f.bin` is read as `C:srcf.bin`, and an
 * unescaped destination `C:\Users\dev\f.bin` writes a file literally named `C` in the start
 * directory — while sftp still exits 0. Both measured on Windows 11 / OpenSSH 10.0p2.
 */
export function quoteSftpBatchArgument(value: string): string {
  if (/[\n\r\0]/.test(value)) {
    // A line break would split one batch command into two; NUL truncates the argument.
    throw new UnsupportedSftpPathError(value)
  }
  return `"${value.replace(/([\\"])/g, '\\$1')}"`
}
