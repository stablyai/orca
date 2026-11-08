import type { StagedGeneration } from './generation-store'

// Stages waiting for their host's pages to stop reading the active build, which commit deletes first.
export type DeferredCommits = {
  // A mounted page reading this host's active build; release when it stops.
  hold(hostKey: string): () => void
  // Returns a waiting stage this one replaced in another directory, for the caller to delete.
  defer(staged: StagedGeneration): StagedGeneration | null
  // The waiting stage to commit now, when no page reads this host's build.
  takeUnread(hostKey: string): StagedGeneration | null
  // A release while this page fetches the build, or null when another page fetches it or it already waits, so it downloads once.
  claim(hostKey: string, buildId: string): (() => void) | null
  // Forgets the stage waiting for this host, and returns it.
  drop(hostKey: string): StagedGeneration | null
}

export function createDeferredCommits(): DeferredCommits {
  const readers = new Map<string, number>()
  const waiting = new Map<string, StagedGeneration>()
  const fetching = new Set<string>()
  const drop = (hostKey: string): StagedGeneration | null => {
    const found = waiting.get(hostKey)
    if (found === undefined) {
      return null
    }
    waiting.delete(hostKey)
    return found
  }
  return {
    hold: (hostKey) => {
      readers.set(hostKey, (readers.get(hostKey) ?? 0) + 1)
      let held = true
      return () => {
        if (held) {
          held = false
          readers.set(hostKey, (readers.get(hostKey) ?? 1) - 1)
        }
      }
    },
    defer: (staged) => {
      const replaced = drop(staged.hostKey)
      waiting.set(staged.hostKey, staged)
      return replaced?.directory === staged.directory ? null : replaced
    },
    claim: (hostKey, buildId) => {
      const key = `${hostKey}/${buildId}`
      if (fetching.has(key) || waiting.get(hostKey)?.buildId === buildId) {
        return null
      }
      fetching.add(key)
      return () => fetching.delete(key)
    },
    takeUnread: (hostKey) => ((readers.get(hostKey) ?? 0) > 0 ? null : drop(hostKey)),
    drop
  }
}
