/** A refusal that means this filesystem makes no hard links at all, not that one file can't be linked. */
export function isUnsupportedHardLinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS'
}
