import { resolve as resolvePath } from 'node:path'
import { RuntimeClientError } from './runtime-client'

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
