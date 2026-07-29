import { posix, win32 } from 'node:path'

// Why: both PTY spawn paths (default terminal cwd + hidden usage probes) gate a
// security boundary here — an empty, "/", drive-root, or network-share-root cwd
// triggers the unbounded file discovery this guard exists to prevent. Keep the
// detection in one place so a fix to one enforcement path can't skip the other.
export function isRootLikePath(path: string | null | undefined): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) {
    return true
  }
  // A filesystem root is its own parent. Check both POSIX and Windows semantics
  // so a Windows drive/UNC root is still rejected when running on POSIX (and vice
  // versa) — path.dirname alone only understands the host platform's separators.
  const normalized = posix.normalize(trimmed)
  return posix.dirname(normalized) === normalized || win32.dirname(trimmed) === trimmed
}
