import { resolve as resolvePath, win32 } from 'node:path'
import { toWindowsWslUncPath } from '../../shared/file-access/wsl-paths'
import { getWslCallerDistro } from '../hosts/wsl-caller-distro'
import { RuntimeClientError } from '../runtime/connection/types'

function isAbsoluteServerPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  )
}

export function resolveRepoPathArgument(
  inputPath: string,
  cwd: string,
  isRemote: boolean,
  remotePathSubject = 'Remote repo path',
  flag = '--path'
): string {
  if (!isRemote) {
    const wslDistro = getWslCallerDistro(cwd)
    // A Linux absolute path from a WSL shell names a distro file, even when cwd is a /mnt drive.
    if (wslDistro && inputPath.startsWith('/') && !inputPath.startsWith('//')) {
      return win32.resolve(toWindowsWslUncPath('/', wslDistro), inputPath)
    }
    return resolvePath(cwd, inputPath)
  }
  // The client cwd belongs to a different filesystem from a paired runtime's relative paths.
  if (!isAbsoluteServerPath(inputPath)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${remotePathSubject} requires ${flag} to be an absolute path on the remote server.`
    )
  }
  return inputPath
}
