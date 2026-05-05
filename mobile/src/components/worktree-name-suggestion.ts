import { MARINE_CREATURES } from '../constants/marine-creatures'

// Why: matches the desktop fallback in
// src/renderer/src/components/sidebar/worktree-name-suggestions.ts so an empty
// "Workspace name" field on mobile produces the same kind of distinct,
// readable default the desktop UI uses (Nautilus, Seahorse, etc.). The
// desktop version is repo-aware via its full worktree map; mobile only has a
// flat list of existing display names per host, which is enough to avoid
// collisions for the common case.

function normalize(name: string): string {
  return name.trim().toLowerCase()
}

export function getSuggestedCreatureName(existingNames: readonly string[]): string {
  const used = new Set<string>()
  for (const name of existingNames) {
    used.add(normalize(name))
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
