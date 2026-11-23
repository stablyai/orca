/** True when the filesystem itself can't make hard links, as opposed to a failed link. */
export function isHardLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
    return true
  }
  // Windows reports a share's "Incorrect function" as EISDIR; Linux vfat/exfat refuse link() with EPERM.
  return process.platform === 'win32' ? code === 'EISDIR' : code === 'EPERM'
}
