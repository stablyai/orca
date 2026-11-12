export type WorktreeRemovalTarget = { worktreeId: string; connectionId: string | null }

export function worktreeRemovalTargetKey(target: WorktreeRemovalTarget): string {
  return JSON.stringify([target.connectionId, target.worktreeId])
}

export function indexWorktreeRemovalTargets(
  targets: readonly WorktreeRemovalTarget[]
): Map<string, Map<string | null, WorktreeRemovalTarget>> {
  const index = new Map<string, Map<string | null, WorktreeRemovalTarget>>()
  for (const target of targets) {
    let hosts = index.get(target.worktreeId)
    if (!hosts) {
      hosts = new Map()
      index.set(target.worktreeId, hosts)
    }
    hosts.set(target.connectionId, target)
  }
  return index
}
