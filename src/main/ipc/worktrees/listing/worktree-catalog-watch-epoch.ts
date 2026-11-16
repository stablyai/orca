type WorktreeCatalogWatchEpochReader = (repoId: string) => number | null

let nextEpoch = 0
let readEpoch: WorktreeCatalogWatchEpochReader | null = null

export function nextWorktreeCatalogWatchEpoch(): number {
  nextEpoch += 1
  return nextEpoch
}

export function setWorktreeCatalogWatchEpochReader(
  reader: WorktreeCatalogWatchEpochReader | null
): void {
  readEpoch = reader
}

/** Null unless a live watch would move the epoch on any listing or head change of this repo. */
export function readWorktreeCatalogWatchEpoch(repoId: string): number | null {
  return readEpoch?.(repoId) ?? null
}
