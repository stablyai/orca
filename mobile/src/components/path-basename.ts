// Why: cross-platform path basename — handles both POSIX ("/") and Windows
// ("\\") separators, mirroring src/renderer/src/lib/path.ts so mobile path
// display and collision checks agree with the desktop.
function stripTrailingSeparators(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

export function pathBasename(p: string): string {
  const normalized = stripTrailingSeparators(p)
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}
