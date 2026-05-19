import { MARINE_CREATURES } from '../constants/marine-creatures'

// Why: matches the desktop fallback in
// src/renderer/src/components/sidebar/worktree-name-suggestions.ts. The
// "already exists locally" collision is on the on-disk worktree directory
// name (the path basename), not the user-facing displayName — so we derive
// the used set from path basenames just like the desktop does.

function stripTrailingSeparators(p: string): string {
  return p.replace(/[\\/]+$/, '')
}

// Why: cross-platform path basename — handles both POSIX ("/") and Windows
// ("\\") separators, mirroring src/renderer/src/lib/path.ts so the mobile
// suggestion logic agrees with the desktop's collision check.
export function pathBasename(p: string): string {
  const normalized = stripTrailingSeparators(p)
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function normalize(name: string): string {
  return name.trim().toLowerCase()
}

export function getSuggestedCreatureName(existingPaths: readonly string[]): string {
  const used = new Set<string>()
  for (const p of existingPaths) {
    used.add(normalize(pathBasename(p)))
  }
  for (const candidate of MARINE_CREATURES) {
    if (!used.has(normalize(candidate))) return candidate
  }
  let suffix = 2
  while (true) {
    for (const candidate of MARINE_CREATURES) {
      const numbered = `${candidate}-${suffix}`
      if (!used.has(normalize(numbered))) return numbered
    }
    suffix += 1
  }
}
