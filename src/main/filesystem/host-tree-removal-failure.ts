import { dirname } from 'node:path'
import { stripWin32LongPathPrefix } from '../../shared/file-access/windows-path-access'

// Failed-delete rows show this message; name the blocking file instead of Node's error text.
export function describeRemovalFailure(error: unknown): unknown {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  const path = error instanceof Error && 'path' in error ? error.path : undefined
  if (path === undefined || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
    return error
  }
  const file = stripWin32LongPathPrefix(String(path))
  const syscall = error instanceof Error && 'syscall' in error ? error.syscall : undefined
  return Object.assign(new Error(removalFailureMessage(code, file, syscall), { cause: error }), {
    code,
    path: file
  })
}

function removalFailureMessage(code: string, file: string, syscall: unknown): string {
  if (code === 'EBUSY') {
    return `${file} is open in another program. Close that program and delete again.`
  }
  if (process.platform === 'win32') {
    return `${file} could not be deleted; it may be read-only or open in another program. Close any program using it and delete again.`
  }
  if (code === 'EPERM') {
    // POSIX EPERM: an immutable flag, or a sticky-bit folder entry owned by another user.
    return `${file} could not be deleted; it may be locked or owned by another user. Unlock it or change its owner, then delete again.`
  }
  const folder = blockingFolder(file, syscall)
  if (folder === undefined) {
    return `${file} could not be deleted: permission denied. Check the owner and permissions of it and its folders, then delete again.`
  }
  return `${file} could not be deleted: you do not have permission to change ${folder} (it may be owned by another user). Change its owner or permissions, then delete again.`
}

// POSIX EACCES: unlink/rmdir need write access to the containing folder, lstat needs search access to it,
// and listing needs read access to the folder itself. Other syscalls do not identify a folder.
function blockingFolder(file: string, syscall: unknown): string | undefined {
  if (syscall === 'scandir') {
    return file
  }
  if (syscall === 'unlink' || syscall === 'rmdir' || syscall === 'lstat') {
    return dirname(file)
  }
  return undefined
}
