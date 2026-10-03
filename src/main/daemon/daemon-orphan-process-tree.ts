// One index over a reconciler tick's process-table capture, built once and shared by every walk
// the tick makes: live-session protection, identity refresh and the owned-member walk.

import { buildProcessTableIndex, type ProcessTableIndexOf } from '../../shared/process-table-index'
import type { ProcessTableRow } from '../pty-process-table-parser'

export type OrphanProcessTree = ProcessTableIndexOf<ProcessTableRow> & {
  /** Pids a non-atomic capture listed more than once. Their parentage cannot be trusted. */
  duplicatePids: ReadonlySet<number>
}

export type ProtectedProcesses = { pids: Set<number>; pgids: Set<number> }

export function buildOrphanProcessTree(table: readonly ProcessTableRow[]): OrphanProcessTree {
  const index = buildProcessTableIndex(table)
  const seen = new Set<number>()
  const duplicatePids = new Set<number>()
  for (const row of table) {
    if (seen.has(row.pid)) {
      duplicatePids.add(row.pid)
    }
    seen.add(row.pid)
  }
  return { ...index, duplicatePids }
}

/**
 * Everything below a root present exactly once in the capture. A root listed twice could be an
 * old row beside a recycled one, so it has no trustworthy children; the visited set keeps a
 * cyclic-looking non-atomic capture from looping.
 */
export function descendantsOf(tree: OrphanProcessTree, rootPid: number): ProcessTableRow[] {
  if (!tree.byPid.has(rootPid) || tree.duplicatePids.has(rootPid)) {
    return []
  }
  const descendants: ProcessTableRow[] = []
  const visited = new Set<number>([rootPid])
  const queue = [rootPid]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of tree.childrenByPpid.get(queue[cursor]) ?? []) {
      if (!visited.has(child.pid)) {
        visited.add(child.pid)
        descendants.push(child)
        queue.push(child.pid)
      }
    }
  }
  return descendants
}

/**
 * Every pid in this daemon's own parent chain, plus the process group of each. A development
 * daemon shares a terminal and often a process group with the shell that launched it, and no
 * record may ever make one of those a reap candidate.
 */
export function collectProtectedAncestry(
  tree: OrphanProcessTree,
  selfPid: number
): ProtectedProcesses {
  const pids = new Set<number>([selfPid])
  // 0 and 1 are the kernel and init groups; signalling either is never this mechanism's job.
  const pgids = new Set<number>([0, 1])
  const selfRow = tree.byPid.get(selfPid)
  if (selfRow) {
    pgids.add(selfRow.pgid)
  }
  for (let row = selfRow; row && row.ppid > 0;) {
    const parent = tree.byPid.get(row.ppid)
    if (!parent || pids.has(parent.pid)) {
      break
    }
    pids.add(parent.pid)
    pgids.add(parent.pgid)
    row = parent
  }
  return { pids, pgids }
}

/** Add a live root and everything under it, pids and groups both, to the protected set. Walks
 *  even a duplicated root: over-protecting costs a tick, under-protecting costs a live session. */
export function protectLiveTree(
  protectedProcesses: ProtectedProcesses,
  tree: OrphanProcessTree,
  rootPid: number
): void {
  protectedProcesses.pids.add(rootPid)
  const rootRow = tree.byPid.get(rootPid)
  if (rootRow) {
    protectedProcesses.pgids.add(rootRow.pgid)
  }
  const visited = new Set<number>([rootPid])
  const queue = [rootPid]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of tree.childrenByPpid.get(queue[cursor]) ?? []) {
      if (!visited.has(child.pid)) {
        visited.add(child.pid)
        protectedProcesses.pids.add(child.pid)
        protectedProcesses.pgids.add(child.pgid)
        queue.push(child.pid)
      }
    }
  }
}

export function isProtected(row: ProcessTableRow, protectedProcesses: ProtectedProcesses): boolean {
  return protectedProcesses.pids.has(row.pid) || protectedProcesses.pgids.has(row.pgid)
}
