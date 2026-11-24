import { readFile, readdir, readlink } from 'node:fs/promises'

export type ProcReader = {
  listPids: () => Promise<string[]>
  listFds: (pid: string) => Promise<string[]>
  readFdLink: (pid: string, fd: string) => Promise<string>
  readStat: (pid: string) => Promise<string>
}

const procReader: ProcReader = {
  listPids: async () => (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry)),
  listFds: (pid) => readdir(`/proc/${pid}/fd`),
  readFdLink: (pid, fd) => readlink(`/proc/${pid}/fd/${fd}`),
  readStat: (pid) => readFile(`/proc/${pid}/stat`, 'utf-8')
}

// Fd passing to an already-running process is invisible without a full walk; bound how long it can go unseen.
const MAX_REUSED_SCANS = 9
const MAX_REUSE_AGE_MS = 5 * 60_000

type OwnerSnapshot = {
  inodeSignature: string
  inodeToPid: Map<number, number>
  startTimeByPid: Map<number, string>
  knownPids: Set<string>
  reusedScans: number
  walkedAt: number
}

export type LinuxSocketOwnerResolver = (
  inodes: Set<number>,
  ownedInodes: Set<number>,
  options?: { requireFresh?: boolean }
) => Promise<Map<number, number>>

/**
 * Map listening socket inodes to pids. A full walk reads every fd of every process; while the listener set is
 * unchanged, re-check only the cached owners' fds and processes started since the last walk.
 */
export function createLinuxSocketOwnerResolver(
  proc: ProcReader = procReader,
  now: () => number = Date.now
): LinuxSocketOwnerResolver {
  let last: OwnerSnapshot | null = null

  return async (inodes, ownedInodes, options = {}) => {
    if (inodes.size === 0) {
      last = null
      return new Map()
    }
    const inodeSignature = [...inodes].sort((a, b) => a - b).join(',')
    const cached = last
    last = null
    if (
      !options.requireFresh &&
      cached?.inodeSignature === inodeSignature &&
      cached.reusedScans < MAX_REUSED_SCANS &&
      now() - cached.walkedAt < MAX_REUSE_AGE_MS
    ) {
      const revalidated = await revalidate(proc, cached, inodes)
      if (revalidated) {
        last = { ...revalidated, reusedScans: cached.reusedScans + 1 }
        return new Map(revalidated.inodeToPid)
      }
    }
    const pids = await listPids(proc)
    const inodeToPid = new Map<number, number>()
    for (const pid of pids) {
      await recordHeldSockets(proc, pid, inodes, inodeToPid)
    }
    if ([...ownedInodes].some((inode) => !inodeToPid.has(inode))) {
      return inodeToPid
    }
    const startTimeByPid = await readStartTimes(proc, inodeToPid)
    if (startTimeByPid) {
      last = {
        inodeSignature,
        inodeToPid,
        startTimeByPid,
        knownPids: new Set(pids),
        reusedScans: 0,
        walkedAt: now()
      }
    }
    return new Map(inodeToPid)
  }
}

export const resolveLinuxSocketOwners = createLinuxSocketOwnerResolver()

/** Same answer as a full walk unless a socket was passed to a process that already existed at the last walk. */
async function revalidate(
  proc: ProcReader,
  cached: OwnerSnapshot,
  inodes: Set<number>
): Promise<Omit<OwnerSnapshot, 'reusedScans'> | null> {
  for (const [pid, startTime] of cached.startTimeByPid) {
    if ((await readProcStartTime(proc, String(pid))) !== startTime) {
      return null
    }
    const held = await heldSockets(proc, String(pid), inodes)
    for (const [inode, owner] of cached.inodeToPid) {
      // An owner that closed its copy may leave the socket with an older holder only a full walk finds.
      if (owner === pid && !held.has(inode)) {
        return null
      }
    }
  }
  const pids = await listPids(proc)
  const inodeToPid = new Map(cached.inodeToPid)
  for (const pid of pids) {
    if (!cached.knownPids.has(pid)) {
      await recordHeldSockets(proc, pid, inodes, inodeToPid)
    }
  }
  const startTimeByPid = await readStartTimes(proc, inodeToPid)
  if (!startTimeByPid) {
    return null
  }
  return {
    inodeSignature: cached.inodeSignature,
    inodeToPid,
    startTimeByPid,
    knownPids: new Set(pids),
    walkedAt: cached.walkedAt
  }
}

// A full walk visits /proc in ascending pid order and keeps the last holder; match that for new holders.
async function recordHeldSockets(
  proc: ProcReader,
  pidText: string,
  inodes: Set<number>,
  inodeToPid: Map<number, number>
): Promise<void> {
  const pid = Number.parseInt(pidText, 10)
  for (const inode of await heldSockets(proc, pidText, inodes)) {
    const current = inodeToPid.get(inode)
    if (current === undefined || pid > current) {
      inodeToPid.set(inode, pid)
    }
  }
}

async function heldSockets(
  proc: ProcReader,
  pid: string,
  inodes: Set<number>
): Promise<Set<number>> {
  const held = new Set<number>()
  let fds: string[]
  try {
    fds = await proc.listFds(pid)
  } catch {
    return held
  }
  for (const fd of fds) {
    let link: string
    try {
      link = await proc.readFdLink(pid, fd)
    } catch {
      continue
    }
    const match = link.match(/^socket:\[(\d+)\]$/)
    const inode = match ? Number.parseInt(match[1], 10) : undefined
    if (inode !== undefined && inodes.has(inode)) {
      held.add(inode)
    }
  }
  return held
}

async function listPids(proc: ProcReader): Promise<string[]> {
  try {
    return (await proc.listPids()).sort((a, b) => Number(a) - Number(b))
  } catch {
    return []
  }
}

async function readStartTimes(
  proc: ProcReader,
  inodeToPid: Map<number, number>
): Promise<Map<number, string> | null> {
  const startTimeByPid = new Map<number, string>()
  for (const pid of new Set(inodeToPid.values())) {
    const startTime = await readProcStartTime(proc, String(pid))
    if (startTime === undefined) {
      return null
    }
    startTimeByPid.set(pid, startTime)
  }
  return startTimeByPid
}

// Start time distinguishes a reused pid.
async function readProcStartTime(proc: ProcReader, pid: string): Promise<string | undefined> {
  try {
    const stat = await proc.readStat(pid)
    // Field 22 (starttime); comm (field 2) may contain spaces, so count after its closing paren.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}
