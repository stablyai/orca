import { posix, win32 } from 'node:path'

// Default terminals and hidden probes share this boundary to prevent unbounded discovery from root-like cwd.
export function isRootLikePath(path: string | null | undefined): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) {
    return true
  }
  // Roots are their own parent; check both platform syntaxes even on a foreign host.
  const normalized = posix.normalize(trimmed)
  return posix.dirname(normalized) === normalized || win32.dirname(trimmed) === trimmed
}
