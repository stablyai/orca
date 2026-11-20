import { readdir, readlink } from 'node:fs/promises'

// Backstop for holders a partial pass cannot see: a socket passed to an existing process, or pid reuse.
const FULL_WALK_INTERVAL_SCANS = 10
const SOCKET_LINK = /^socket:\[(\d+)\]$/

let ownerPidByInode = new Map<number, number>()
let previousInodes = new Set<number>()
let previousPids: ReadonlySet<number> | undefined
let scanSequence = 0
let lastFullWalkScan = Number.NEGATIVE_INFINITY

/**
 * Map listener socket inodes to the pid holding them; a shared socket goes to the last holder in /proc order.
 * Between full walks only cached owners and pids new since the last scan are read: a process that
 * inherited a listening socket by fork is always a new pid.
 */
export async function resolveLinuxSocketOwners(
  inodes: ReadonlySet<number>,
  { fresh }: { fresh?: boolean } = {}
): Promise<Map<number, number>> {
  const sequence = ++scanSequence
  // Overlapping scans replace the module state, so each call works from the state it started with.
  const cachedOwners = ownerPidByInode
  const seenBefore = previousPids
  const knownInodes = previousInodes
  const owners = new Map<number, number>()
  if (inodes.size === 0) {
    ownerPidByInode = new Map()
    previousInodes = new Set()
    return owners
  }
  let pids: number[]
  try {
    pids = (await readdir('/proc'))
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => Number.parseInt(entry, 10))
  } catch {
    return owners
  }

  // A cached pair counts only after re-reading that pid's fds, so pid reuse or a closed socket drops it.
  const cachedOwnerSockets = new Map<number, ReadonlySet<number>>()
  let lostOwner = false
  for (const inode of inodes) {
    const pid = cachedOwners.get(inode)
    if (pid === undefined) {
      continue
    }
    let sockets = cachedOwnerSockets.get(pid)
    if (!sockets) {
      sockets = await readPidListenerSockets(pid, inodes)
      cachedOwnerSockets.set(pid, sockets)
    }
    if (!sockets.has(inode)) {
      lostOwner = true
    }
  }
  const fullWalk =
    fresh ||
    seenBefore === undefined ||
    lostOwner ||
    sequence - lastFullWalkScan >= FULL_WALK_INTERVAL_SCANS ||
    [...inodes].some((inode) => !knownInodes.has(inode))

  for (const pid of pids) {
    const cached = cachedOwnerSockets.get(pid)
    cachedOwnerSockets.delete(pid)
    if (cached || fullWalk || !seenBefore?.has(pid)) {
      for (const inode of cached ?? (await readPidListenerSockets(pid, inodes))) {
        owners.set(inode, pid)
      }
    }
  }

  if (fullWalk) {
    lastFullWalkScan = Math.max(lastFullWalkScan, sequence)
  }
  ownerPidByInode = owners
  previousInodes = new Set(inodes)
  previousPids = new Set(pids)
  return new Map(owners)
}

/** Keeps only listener inodes, not every connection the process holds. */
async function readPidListenerSockets(
  pid: number,
  listenerInodes: ReadonlySet<number>
): Promise<Set<number>> {
  const found = new Set<number>()
  let fds: string[]
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    return found
  }
  for (const fd of fds) {
    let link: string
    try {
      link = await readlink(`/proc/${pid}/fd/${fd}`)
    } catch {
      continue
    }
    const match = SOCKET_LINK.exec(link)
    const inode = match ? Number.parseInt(match[1], 10) : undefined
    if (inode !== undefined && listenerInodes.has(inode)) {
      found.add(inode)
    }
  }
  return found
}
