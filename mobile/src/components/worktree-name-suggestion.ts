import { MARINE_CREATURES } from '../constants/marine-creatures'
import { pathBasename } from './path-basename'

// Why: matches the desktop fallback in
// src/renderer/src/components/sidebar/worktree-name-suggestions.ts. The
// "already exists locally" collision is on the on-disk worktree directory
// name (the path basename), not the user-facing displayName — so we derive
// the used set from path basenames just like the desktop does.

function normalize(name: string): string {
  return name.trim().toLowerCase()
}

function pickRandom<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]
}

// Why: pick randomly from the unused pool (not the first in list order) so
// fresh worktrees don't all default to "Nautilus" and collide across repos.
export function getSuggestedCreatureName(
  existingPaths: readonly string[],
  random: () => number = Math.random
): string {
  const used = new Set<string>()
  for (const p of existingPaths) {
    used.add(normalize(pathBasename(p)))
  }
  // Lowercased to match branch-name convention (fix/seahorse, not fix/Seahorse).
  const available = MARINE_CREATURES.map(normalize).filter((name) => !used.has(name))
  if (available.length > 0) {
    return pickRandom(available, random)
  }
  let suffix = 2
  while (true) {
    const numbered = MARINE_CREATURES.map((name) => `${normalize(name)}-${suffix}`).filter(
      (name) => !used.has(name)
    )
    if (numbered.length > 0) {
      return pickRandom(numbered, random)
    }
    suffix += 1
  }
}
