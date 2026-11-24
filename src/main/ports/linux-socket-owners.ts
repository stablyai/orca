import { readdir, readlink } from 'node:fs/promises'
import { runPortScanCommand } from './port-scan-command-client'

const LISTING_RETRY_SCANS = 9
let scansUntilListingRetry = 0

/** Map listening socket inodes to the pid a full /proc walk keeps: the last holder in /proc's listing order. */
export async function resolveLinuxSocketOwners(
  inodes: Set<number>,
  options: { requireExact?: boolean } = {}
): Promise<Map<number, number>> {
  if (inodes.size === 0) {
    return new Map()
  }
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  } catch {
    return new Map()
  }
  // Kill and allow-list checks read each link exactly; ls prints raw paths, so a crafted name could fake a row.
  if (options.requireExact) {
    return walkProcSocketOwners(pids, inodes)
  }
  // After a failed listing, don't pay for it and the walk on every scan; retry it every 10th scan.
  if (scansUntilListingRetry > 0) {
    scansUntilListingRetry -= 1
    return walkProcSocketOwners(pids, inodes)
  }
  // One ls in the port-scan worker replaces ~one readlink promise per fd on Electron main.
  // The worker lists `<pid> socket:[<inode>]` holders of these inodes, then `seen <n>` well-formed socket rows.
  const listing = await runPortScanCommand('/bin/ls', [], undefined, [...inodes]).catch(() => null)
  const parsed = listing ? parseSocketHolderListing(listing.stdout) : null
  if (!parsed || parsed.seen === 0) {
    scansUntilListingRetry = LISTING_RETRY_SCANS
    return walkProcSocketOwners(pids, inodes)
  }
  return pickLastHolders(parsed.holders, pids, inodes)
}

/** Holder lines and the `seen` total from the worker's listing; null when the total line is missing. */
export function parseSocketHolderListing(
  output: string
): { holders: { pid: number; inode: number }[]; seen: number } | null {
  const holders: { pid: number; inode: number }[] = []
  let seen: number | null = null
  for (const line of output.split('\n')) {
    const holder = /^(\d+) socket:\[(\d+)\]$/.exec(line)
    if (holder) {
      holders.push({ pid: Number(holder[1]), inode: Number(holder[2]) })
      continue
    }
    const total = /^seen (\d+)$/.exec(line)
    if (total) {
      seen = Number(total[1])
    }
  }
  return seen === null ? null : { holders, seen }
}

/** Keep, per inode, the holder a walk in `pidOrder` would visit last; pids missing from it are ones the walk never sees. */
export function pickLastHolders(
  holders: readonly { pid: number; inode: number }[],
  pidOrder: readonly string[],
  inodes: Set<number>
): Map<number, number> {
  const rank = new Map(pidOrder.map((pid, index) => [Number(pid), index]))
  const result = new Map<number, number>()
  for (const { pid, inode } of holders) {
    const index = rank.get(pid)
    const current = result.get(inode)
    if (
      index !== undefined &&
      inodes.has(inode) &&
      (current === undefined || index > (rank.get(current) ?? -1))
    ) {
      result.set(inode, pid)
    }
  }
  return result
}

async function walkProcSocketOwners(
  pids: readonly string[],
  inodes: Set<number>
): Promise<Map<number, number>> {
  const result = new Map<number, number>()
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
