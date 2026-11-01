// An anchor must outlive its terminal: macOS forgets a dead responsible process, and with it the
// only record of which terminal a daemonized descendant came from. See terminal-anchor-entry.ts.
const anchoredRoots = new Set<number>()

export function markPtyRootAnchored(rootPid: number): void {
  anchoredRoots.add(rootPid)
}

export function unmarkPtyRootAnchored(rootPid: number): void {
  anchoredRoots.delete(rootPid)
}

export function isPtyRootAnchored(rootPid: number): boolean {
  return anchoredRoots.has(rootPid)
}
