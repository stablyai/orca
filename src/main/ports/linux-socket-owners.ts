import { readFile, readdir, readlink } from 'node:fs/promises'

type OwnerSnapshot = {
  inodeSignature: string
  inodeToPid: Map<number, number>
  startTimeByPid: Map<number, string>
}

let lastOwners: OwnerSnapshot | null = null

/** Map listening socket inodes to pids, walking every /proc/<pid>/fd only when the listener set or an owner changed. */
export async function resolveLinuxSocketOwners(
  inodes: Set<number>,
  options: { requireFresh?: boolean } = {}
): Promise<Map<number, number>> {
  if (inodes.size === 0) {
    lastOwners = null
    return new Map()
  }
  const inodeSignature = [...inodes].sort((a, b) => a - b).join(',')
  const cached = lastOwners
  if (
    !options.requireFresh &&
    cached?.inodeSignature === inodeSignature &&
    (await ownersUnchanged(cached.startTimeByPid))
  ) {
    return new Map(cached.inodeToPid)
  }
  const inodeToPid = await walkProcSocketOwners(inodes)
  const startTimeByPid = new Map<number, string>()
  for (const pid of new Set(inodeToPid.values())) {
    const startTime = await readProcStartTime(pid)
    if (startTime === undefined) {
      lastOwners = null
      return inodeToPid
    }
    startTimeByPid.set(pid, startTime)
  }
  lastOwners = { inodeSignature, inodeToPid, startTimeByPid }
  return new Map(inodeToPid)
}

// Why: start time distinguishes a reused pid; an exited owner can leave its socket to a child.
async function ownersUnchanged(startTimeByPid: Map<number, string>): Promise<boolean> {
  for (const [pid, startTime] of startTimeByPid) {
    if ((await readProcStartTime(pid)) !== startTime) {
      return false
    }
  }
  return true
}

async function readProcStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf-8')
    // Field 22 (starttime); comm (field 2) may contain spaces, so count after its closing paren.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

async function walkProcSocketOwners(inodes: Set<number>): Promise<Map<number, number>> {
  const result = new Map<number, number>()
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  } catch {
    return result
  }

  for (const pidText of pids) {
    let fds: string[]
    try {
      fds = await readdir(`/proc/${pidText}/fd`)
    } catch {
      continue
    }
    const pid = Number.parseInt(pidText, 10)
    for (const fd of fds) {
      let link: string
      try {
        link = await readlink(`/proc/${pidText}/fd/${fd}`)
      } catch {
        continue
      }
      const match = link.match(/^socket:\[(\d+)\]$/)
      if (!match) {
        continue
      }
      const inode = Number.parseInt(match[1], 10)
      if (inodes.has(inode)) {
        result.set(inode, pid)
      }
    }
  }
  return result
}
