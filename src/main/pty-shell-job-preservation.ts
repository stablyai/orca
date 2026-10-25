import type { DescendantSnapshot } from './pty-descendant-termination'

/** Graceful plain-shell close leaves nohup/disown jobs to the shell's SIGHUP, as any terminal does.
 *  Only background groups the shell itself leads qualify; agent-made groups (Codex MCP servers) are still swept. */
export function excludeShellBackgroundJobs(
  snapshot: DescendantSnapshot,
  shellIsRootChild: boolean
): DescendantSnapshot {
  const rootPid = snapshot.root?.pid
  let shell = { pid: rootPid, pgid: snapshot.rootPgid }
  if (shellIsRootChild) {
    const children = snapshot.descendants.filter((row) => row.ppid === rootPid)
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
