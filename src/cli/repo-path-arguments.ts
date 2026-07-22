import { resolve as resolvePath } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { RuntimeClientError } from './runtime-client'

function isAbsoluteServerPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    value.startsWith('//') ||
    value === '~' ||
    value.startsWith('~/')
  )
}

export function resolveRepoPathArgument(
  inputPath: string,
  cwd: string,
  isRemote: boolean,
  remotePathSubject = 'Remote repo path'
): string {
  if (!isRemote) {
    // Why: win32 path.resolve turns `/home/foo` into `C:\home\foo`, which is never the
    // intended local path and hides SSH/remote-host imports behind a bogus desktop probe.
    if (
      process.platform === 'win32' &&
      inputPath.startsWith('/') &&
      !isWindowsAbsolutePathLike(inputPath)
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${remotePathSubject} looks like a remote POSIX path on the Windows desktop. Pass --host ssh:<connectionId> (not --environment) so Orca validates it on that SSH host.`
      )
    }
    return resolvePath(cwd, inputPath)
  }
  // Why: the local CLI cwd is unrelated to a paired runtime's filesystem.
  // Relative remote paths would silently target the wrong machine.
  if (!isAbsoluteServerPath(inputPath)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${remotePathSubject} requires --path to be an absolute path on the remote server.`
    )
  }
  return inputPath
}
