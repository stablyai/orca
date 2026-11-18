import { basename } from 'node:path'

// Rollout names a cleanup is deleting, counted per concurrent hold.
const heldRollouts = new Map<string, number>()
// Async links that give a rollout a new name, so a hold can wait for ones already started.
const linksInFlight = new Map<string, Set<Promise<unknown>>>()

/** Archived `.jsonl.zst` and live `.jsonl` names are one rollout. */
function rolloutKey(path: string): string {
  const name = basename(path)
  return name.endsWith('.zst') ? name.slice(0, -'.zst'.length) : name
}

export function isCodexRolloutHeldForDeletion(path: string): boolean {
  return heldRollouts.size > 0 && heldRollouts.has(rolloutKey(path))
}

/** Runs an async link of this rollout unless a cleanup holds it; a hold waits for it to settle. */
export async function linkCodexRolloutUnlessHeld<T>(
  sourcePath: string,
  createLink: () => Promise<T>
): Promise<T | 'held'> {
  const key = rolloutKey(sourcePath)
  if (heldRollouts.has(key)) {
    return 'held'
  }
  const pending = createLink()
  const inFlight = linksInFlight.get(key) ?? new Set()
  linksInFlight.set(key, inFlight)
  inFlight.add(pending)
  try {
    return await pending
  } finally {
    inFlight.delete(pending)
    if (inFlight.size === 0) {
      linksInFlight.delete(key)
    }
  }
}

/**
 * Stops history passes from giving a rollout a new name while every name it has is deleted, once
 * links already under way have landed theirs. Synchronous links check the hold in the same tick.
 */
export async function holdCodexRolloutForDeletion(path: string): Promise<() => void> {
  const key = rolloutKey(path)
  heldRollouts.set(key, (heldRollouts.get(key) ?? 0) + 1)
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    const remaining = (heldRollouts.get(key) ?? 1) - 1
    if (remaining > 0) {
      heldRollouts.set(key, remaining)
    } else {
      heldRollouts.delete(key)
    }
  }
  const inFlight = linksInFlight.get(key)
  if (inFlight) {
    await Promise.allSettled(Array.from(inFlight))
  }
  return release
}
