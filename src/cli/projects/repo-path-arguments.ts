import { posix, resolve as resolvePath, win32 } from 'node:path'
import {
  isWslUncPath,
  toWindowsWslDrivePath,
  toWindowsWslUncPath
} from '../../shared/file-access/wsl-paths'
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
    // A Linux absolute path from a WSL shell names a distro file, even when cwd is a drive path.
    if (wslDistro && inputPath.startsWith('/') && !inputPath.startsWith('//')) {
      const linuxPath = posix.normalize(inputPath)
      // WSL refuses drive mounts over UNC, and a UNC cwd keeps its \\wsl$ or \\wsl.localhost spelling.
      return (
        toWindowsWslDrivePath(linuxPath) ??
        win32.resolve(isWslUncPath(cwd) ? cwd : toWindowsWslUncPath('/', wslDistro), linuxPath)
      )
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
