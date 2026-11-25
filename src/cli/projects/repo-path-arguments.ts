import { resolveCallerLocalPath } from '../../shared/file-access/caller-local-path'
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
    return resolveCallerLocalPath(inputPath, cwd, getWslCallerDistro(cwd))
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
