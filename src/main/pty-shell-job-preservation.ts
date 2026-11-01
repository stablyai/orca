import type { DescendantSnapshot } from './pty-descendant-termination'

/** Let SIGHUP decide shell-owned background jobs on graceful close; still sweep agent-created groups. */
export function excludeShellBackgroundJobs(
  snapshot: DescendantSnapshot,
  shellIsRootChild: boolean
): DescendantSnapshot {
  let shell: { pid?: number; pgid: number | null } = {
    pid: snapshot.root?.pid,
    pgid: snapshot.rootPgid
  }
  if (snapshot.anchorPid !== undefined) {
    // What Orca spawned sits under the anchor, so it stands in for the root below.
    const spawned = snapshot.descendants.filter((row) => row.ppid === snapshot.anchorPid)
    if (spawned.length !== 1) {
      return snapshot
    }
    shell = spawned[0]
  }
  if (shellIsRootChild) {
    const children = snapshot.descendants.filter((row) => row.ppid === shell.pid)
    // Without one unambiguous shell, sweep everything rather than guess.
    if (children.length !== 1) {
      return snapshot
    }
    shell = children[0]
  }
  const shellJobPgids = new Set(
    snapshot.descendants
      .filter(
        (row) =>
          row.pid === row.pgid &&
          row.ppid === shell.pid &&
          row.pgid !== shell.pgid &&
          row.pgid !== snapshot.rootPgid &&
          (row.tpgid ?? 0) > 0 &&
          row.pgid !== row.tpgid
      )
      .map((row) => row.pgid)
  )
  if (shellJobPgids.size === 0) {
    return snapshot
  }
  return {
    ...snapshot,
    descendants: snapshot.descendants.filter((row) => !shellJobPgids.has(row.pgid))
  }
}
