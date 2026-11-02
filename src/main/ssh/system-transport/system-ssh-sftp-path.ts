import { normalizeWindowsRemotePath } from '../ssh-remote-platform'

/** Unsupported paths decline this operation to another transport. */
export class UnsupportedSftpPathError extends Error {
  constructor(path: string) {
    super(`Path cannot be addressed over sftp: ${JSON.stringify(path)}`)
    this.name = 'UnsupportedSftpPathError'
  }
}

/** Windows SFTP roots drive paths under /: C:/Users/dev becomes /C:/Users/dev. */
export function toSftpRemotePath(remotePath: string): string {
  const normalized = normalizeWindowsRemotePath(remotePath)
  if (/^\/[a-zA-Z]:\//.test(normalized)) {
    return normalized
  }
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `/${normalized}`
  }
  // UNC and relative mappings are unsettled; refuse rather than risk writing to the wrong path.
  throw new UnsupportedSftpPathError(remotePath)
}

/** SFTP consumes backslash escapes even inside quotes; raw Windows paths can silently target a file named C and exit 0. */
export function quoteSftpBatchArgument(value: string): string {
  if (/[\n\r\0]/.test(value)) {
    // A line break would split one batch command into two; NUL truncates the argument.
    throw new UnsupportedSftpPathError(value)
  }
  return `"${value.replace(/([\\"])/g, '\\$1')}"`
}
