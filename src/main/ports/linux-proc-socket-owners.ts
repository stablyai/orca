import { readdir, readlink } from 'node:fs/promises'

// A full walk still runs on this cadence so sockets that became shared, or stayed unresolved, are re-picked.
const FULL_WALK_INTERVAL_SCANS = 10
const SOCKET_LINK = /^socket:\[(\d+)\]$/

let ownerPidByInode = new Map<number, number>()
let missesByInode = new Map<number, number>()
let scanSequence = 0
let lastFullWalkScan = Number.NEGATIVE_INFINITY

/** Map listener socket inodes to the pid holding them, walking all of /proc only when a socket is new or lost its owner. */
export async function resolveLinuxSocketOwners(
  inodes: ReadonlySet<number>,
  { fresh }: { fresh?: boolean } = {}
): Promise<Map<number, number>> {
  scanSequence += 1
  if (inodes.size === 0) {
    ownerPidByInode = new Map()
    missesByInode = new Map()
    return new Map()
  }
  const { owners, socketsByPid } = await verifyCachedOwners(inodes)
  const needsWalk =
    fresh ||
    scanSequence - lastFullWalkScan >= FULL_WALK_INTERVAL_SCANS ||
    [...inodes].some(
      (inode) =>
        !owners.has(inode) &&
        // One immediate retry covers a socket handed to a fork while the last walk ran.
        (ownerPidByInode.has(inode) || (missesByInode.get(inode) ?? 0) < 2)
    )
  if (needsWalk) {
    lastFullWalkScan = scanSequence
    // Every socket is a candidate so a shared one goes to the last holder in /proc order, as before caching.
    await walkProcForOwners(inodes, socketsByPid, owners)
  }

  const nextMisses = new Map<number, number>()
  for (const inode of inodes) {
    if (!owners.has(inode)) {
      const misses = missesByInode.get(inode) ?? 0
      nextMisses.set(inode, needsWalk ? misses + 1 : misses)
    }
  }
  ownerPidByInode = new Map(owners)
  missesByInode = nextMisses
  return owners
}

/** A cached pair is used only after re-reading that pid's fds, so pid reuse or a closed socket drops it. */
async function verifyCachedOwners(
  inodes: ReadonlySet<number>
): Promise<{ owners: Map<number, number>; socketsByPid: Map<number, Set<number>> }> {
  const owners = new Map<number, number>()
  const socketsByPid = new Map<number, Set<number>>()
  for (const inode of inodes) {
    const pid = ownerPidByInode.get(inode)
    if (pid === undefined) {
      continue
    }
    let sockets = socketsByPid.get(pid)
    if (!sockets) {
      sockets = await readPidListenerSockets(pid, inodes)
      socketsByPid.set(pid, sockets)
    }
    if (sockets.has(inode)) {
      owners.set(inode, pid)
    }
  }
  return { owners, socketsByPid }
}

/** Later pids overwrite earlier ones for a shared socket, as the uncached walk always did. */
async function walkProcForOwners(
  inodes: ReadonlySet<number>,
  alreadyRead: ReadonlyMap<number, ReadonlySet<number>>,
  owners: Map<number, number>
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    const pid = Number.parseInt(entry, 10)
    for (const inode of alreadyRead.get(pid) ?? (await readPidListenerSockets(pid, inodes))) {
      owners.set(inode, pid)
    }
  }
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
