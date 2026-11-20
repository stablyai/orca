import { resolve } from 'node:path'

/** One key per file however its path is spelled; Windows paths compare case-insensitively. */
export function fileIdentityKey(filePath: string): string {
  const absolute = resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
