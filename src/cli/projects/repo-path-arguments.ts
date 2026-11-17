import { resolve as resolvePath, win32 } from 'node:path'
import { isWslUncPath, toWindowsWslUncPath } from '../../shared/file-access/wsl-paths'
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
  remotePathSubject = 'Remote repo path'
): string {
  if (!isRemote) {
    const wslDistro = getWslCallerDistro(cwd)
    // A Linux absolute path from a WSL shell names a distro file; a UNC cwd already resolves it.
    if (
      wslDistro &&
      !isWslUncPath(cwd) &&
      inputPath.startsWith('/') &&
      !inputPath.startsWith('//')
    ) {
      return win32.resolve(toWindowsWslUncPath('/', wslDistro), inputPath)
    }
    return resolvePath(cwd, inputPath)
  }
  // The client cwd belongs to a different filesystem from a paired runtime's relative paths.
  if (!isAbsoluteServerPath(inputPath)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${remotePathSubject} requires --path to be an absolute path on the remote server.`
    )
  }
  return inputPath
}
