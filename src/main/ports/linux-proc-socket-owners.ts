import { readFile, readdir, readlink, stat } from 'node:fs/promises'

// Sockets we cannot attribute (root's or other users' services) are searched again on this cadence, not every scan.
const UNREADABLE_RESEARCH_INTERVAL_SCANS = 10
const SOCKET_LINK = /^socket:\[(\d+)\]$/
const CAP_SYS_PTRACE_BIT = 19n

export type LinuxListenerSocket = { inode: number; uid: number }

let ownerPidByInode = new Map<number, number>()
let unresolvedSearchedAtScan = new Map<number, number>()
let scanSequence = 0
let canReadEveryFdTable: Promise<boolean> | undefined

/** Map listener socket inodes to the pid holding them, walking all of /proc only when a socket is new or lost its owner. */
export async function resolveLinuxSocketOwners(
  sockets: readonly LinuxListenerSocket[],
  { ownUid, fresh }: { ownUid: number | undefined; fresh?: boolean }
): Promise<Map<number, number>> {
  scanSequence += 1
  const inodes = new Set(sockets.map((socket) => socket.inode))
  const readAll = await canReadAllFdTables(ownUid)
  const owners = await verifyCachedOwners(inodes)
  const needsWalk = sockets.some((socket) => {
    if (owners.has(socket.inode)) {
      return false
    }
    const searchedAt = unresolvedSearchedAtScan.get(socket.inode)
    return (
      fresh ||
      searchedAt === undefined ||
      ownerPidByInode.has(socket.inode) ||
      // A missed socket of our own (e.g. a fork race mid-walk) is retried next scan.
      (!readAll && socket.uid === ownUid) ||
      scanSequence - searchedAt >= UNREADABLE_RESEARCH_INTERVAL_SCANS
    )
  })
  if (needsWalk) {
    const wanted = new Set([...inodes].filter((inode) => !owners.has(inode)))
    await walkProcForOwners(wanted, readAll ? undefined : ownUid, owners)
  }

  const nextUnresolved = new Map<number, number>()
  for (const inode of inodes) {
    if (!owners.has(inode)) {
      const searchedAt = needsWalk ? scanSequence : unresolvedSearchedAtScan.get(inode)
      nextUnresolved.set(inode, searchedAt ?? scanSequence)
    }
  }
  ownerPidByInode = new Map(owners)
  unresolvedSearchedAtScan = nextUnresolved
  return owners
}

/** Without root or CAP_SYS_PTRACE, /proc/<pid>/fd is readable only for processes running as our uid. */
function canReadAllFdTables(ownUid: number | undefined): Promise<boolean> {
  if (ownUid === undefined || ownUid === 0) {
    return Promise.resolve(true)
  }
  canReadEveryFdTable ??= readFile('/proc/self/status', 'utf-8')
    .then((status) => {
      const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(status)?.[1]
      return capEff !== undefined && ((BigInt(`0x${capEff}`) >> CAP_SYS_PTRACE_BIT) & 1n) === 1n
    })
    .catch(() => false)
  return canReadEveryFdTable
}

/** A cached pair is used only after re-reading that pid's fds, so pid reuse or a closed socket drops it. */
async function verifyCachedOwners(inodes: ReadonlySet<number>): Promise<Map<number, number>> {
  const inodesByPid = new Map<number, Set<number>>()
  for (const inode of inodes) {
    const pid = ownerPidByInode.get(inode)
    if (pid === undefined) {
      continue
    }
    const pidInodes = inodesByPid.get(pid) ?? new Set<number>()
    pidInodes.add(inode)
    inodesByPid.set(pid, pidInodes)
  }
  const owners = new Map<number, number>()
  for (const [pid, pidInodes] of inodesByPid) {
    const remaining = new Set(pidInodes)
    await readPidSockets(pid, (inode) => {
      if (remaining.delete(inode)) {
        owners.set(inode, pid)
      }
      return remaining.size > 0
    })
  }
  return owners
}

/** Later pids overwrite earlier ones for a shared socket, as the uncached walk always did. */
async function walkProcForOwners(
  wanted: ReadonlySet<number>,
  onlyUid: number | undefined,
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
    await readPidSockets(pid, (inode) => {
      if (wanted.has(inode)) {
        owners.set(inode, pid)
      }
      return true
    })
  }
}

/** Calls `onSocket` for each socket fd until it returns false. */
async function readPidSockets(pid: number, onSocket: (inode: number) => boolean): Promise<void> {
  let fds: string[]
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    return
  }
  for (const fd of fds) {
    let link: string
    try {
      link = await readlink(`/proc/${pid}/fd/${fd}`)
    } catch {
      continue
    }
    const match = SOCKET_LINK.exec(link)
    if (match && !onSocket(Number.parseInt(match[1], 10))) {
      return
    }
  }
}
