import { readdir, readlink, stat } from 'node:fs/promises'

// Sockets no visible process holds (other users' services) are searched again on this cadence, not every scan.
const UNRESOLVED_RESEARCH_INTERVAL_SCANS = 10
const SOCKET_LINK = /^socket:\[(\d+)\]$/

let ownerPidByInode = new Map<number, number>()
let unresolvedSearchedAtScan = new Map<number, number>()
let scanSequence = 0

/** Map listener socket inodes to the pid holding them, walking all of /proc only for sockets not seen before. */
export async function resolveLinuxSocketOwners(
  inodes: ReadonlySet<number>,
  ownUid: number | undefined
): Promise<Map<number, number>> {
  scanSequence += 1
  const owners = await verifyCachedOwners(inodes)
  const wanted = new Set<number>()
  for (const inode of inodes) {
    if (owners.has(inode)) {
      continue
    }
    const searchedAt = unresolvedSearchedAtScan.get(inode)
    if (
      ownerPidByInode.has(inode) ||
      searchedAt === undefined ||
      scanSequence - searchedAt >= UNRESOLVED_RESEARCH_INTERVAL_SCANS
    ) {
      wanted.add(inode)
    }
  }
  if (wanted.size > 0) {
    await walkProcForOwners(wanted, ownUid, owners)
  }

  const nextUnresolved = new Map<number, number>()
  for (const inode of inodes) {
    if (owners.has(inode)) {
      continue
    }
    const searchedAt = wanted.has(inode) ? scanSequence : unresolvedSearchedAtScan.get(inode)
    nextUnresolved.set(inode, searchedAt ?? scanSequence)
  }
  ownerPidByInode = new Map(owners)
  unresolvedSearchedAtScan = nextUnresolved
  return owners
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
    await collectPidSockets(pid, pidInodes, owners)
  }
  return owners
}

async function walkProcForOwners(
  wanted: Set<number>,
  ownUid: number | undefined,
  owners: Map<number, number>
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return
  }
  // Without CAP_SYS_PTRACE, /proc/<pid>/fd is readable only for processes running as our uid.
  const ownUidOnly = ownUid !== undefined && ownUid !== 0
  for (const entry of entries) {
    if (wanted.size === 0) {
      return
    }
    if (!/^\d+$/.test(entry)) {
      continue
    }
    if (ownUidOnly) {
      try {
        if ((await stat(`/proc/${entry}`)).uid !== ownUid) {
          continue
        }
      } catch {
        continue
      }
    }
    await collectPidSockets(Number.parseInt(entry, 10), wanted, owners)
  }
}

/** Removes each found inode from `wanted` and stops reading fds once none remain. */
async function collectPidSockets(
  pid: number,
  wanted: Set<number>,
  owners: Map<number, number>
): Promise<void> {
  let fds: string[]
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    return
  }
  for (const fd of fds) {
    if (wanted.size === 0) {
      return
    }
    let link: string
    try {
      link = await readlink(`/proc/${pid}/fd/${fd}`)
    } catch {
      continue
    }
    const match = SOCKET_LINK.exec(link)
    const inode = match ? Number.parseInt(match[1], 10) : undefined
    if (inode !== undefined && wanted.delete(inode)) {
      owners.set(inode, pid)
    }
  }
}
