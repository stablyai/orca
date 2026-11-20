import { readFile, readdir, readlink, stat } from 'node:fs/promises'

// A socket missed twice in a row (root's or other users' services) is searched again on this cadence, not every scan.
const UNRESOLVED_RESEARCH_INTERVAL_SCANS = 10
const SOCKET_LINK = /^socket:\[(\d+)\]$/
const CAP_DAC_OVERRIDE = 1n
const CAP_DAC_READ_SEARCH = 2n
const CAP_SYS_PTRACE = 19n

type UnresolvedSocket = { searchedAtScan: number; misses: number }

let ownerPidByInode = new Map<number, number>()
let unresolvedByInode = new Map<number, UnresolvedSocket>()
let scanSequence = 0
let canReadEveryFdTable: Promise<boolean> | undefined

/** Map listener socket inodes to the pid holding them, walking all of /proc only when a socket is new or lost its owner. */
export async function resolveLinuxSocketOwners(
  inodes: ReadonlySet<number>,
  { ownUid, fresh }: { ownUid: number | undefined; fresh?: boolean }
): Promise<Map<number, number>> {
  scanSequence += 1
  const { owners, socketsByPid } = await verifyCachedOwners(inodes)
  const needsWalk = [...inodes].some((inode) => {
    if (owners.has(inode)) {
      return false
    }
    const unresolved = unresolvedByInode.get(inode)
    return (
      fresh ||
      unresolved === undefined ||
      // One immediate retry covers a socket handed to a fork while the last walk ran.
      unresolved.misses < 2 ||
      scanSequence - unresolved.searchedAtScan >= UNRESOLVED_RESEARCH_INTERVAL_SCANS
    )
  })
  if (needsWalk) {
    const readAll = await canReadAllFdTables(ownUid)
    // Every socket is a candidate so a shared one goes to the last holder in /proc order, as before caching.
    await walkProcForOwners(inodes, readAll ? undefined : ownUid, socketsByPid, owners)
  }

  const nextUnresolved = new Map<number, UnresolvedSocket>()
  for (const inode of inodes) {
    if (owners.has(inode)) {
      continue
    }
    const previous = unresolvedByInode.get(inode)
    nextUnresolved.set(
      inode,
      needsWalk || !previous
        ? { searchedAtScan: scanSequence, misses: (previous?.misses ?? 0) + 1 }
        : previous
    )
  }
  ownerPidByInode = new Map(owners)
  unresolvedByInode = nextUnresolved
  return owners
}

/** /proc/<pid>/fd of another uid needs CAP_SYS_PTRACE plus a DAC bypass to list it; otherwise only our uid's are readable. */
function canReadAllFdTables(ownUid: number | undefined): Promise<boolean> {
  if (ownUid === undefined || ownUid === 0) {
    return Promise.resolve(true)
  }
  canReadEveryFdTable ??= readFile('/proc/self/status', 'utf-8')
    .then((status) => {
      const capEffHex = /^CapEff:\s*([0-9a-f]+)$/m.exec(status)?.[1]
      if (capEffHex === undefined) {
        return false
      }
      const capEff = BigInt(`0x${capEffHex}`)
      const has = (bit: bigint): boolean => ((capEff >> bit) & 1n) === 1n
      return has(CAP_SYS_PTRACE) && (has(CAP_DAC_READ_SEARCH) || has(CAP_DAC_OVERRIDE))
    })
    .catch(() => false)
  return canReadEveryFdTable
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
  wanted: ReadonlySet<number>,
  onlyUid: number | undefined,
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
    if (onlyUid !== undefined) {
      try {
        if ((await stat(`/proc/${entry}`)).uid !== onlyUid) {
          continue
        }
      } catch {
        continue
      }
    }
    const pid = Number.parseInt(entry, 10)
    for (const inode of alreadyRead.get(pid) ?? (await readPidListenerSockets(pid, wanted))) {
      owners.set(inode, pid)
    }
  }
}

/** Keeps only listener inodes, not every connection the process holds. */
async function readPidListenerSockets(
  pid: number,
  listenerInodes: ReadonlySet<number>
): Promise<Set<number>> {
  let fds: string[]
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    return new Set()
  }
  const inodes = new Set<number>()
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
      inodes.add(inode)
    }
  }
  return inodes
}
