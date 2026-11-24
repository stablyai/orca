import { readdir, readlink } from 'node:fs/promises'
import { runPortScanCommand } from './port-scan-command-client'

/** Turns `ls -ln` directory listings into `<pid> socket:[<inode>]` lines. */
export const SOCKET_HOLDER_AWK =
  "awk '/^\\/proc\\/[0-9]+\\/fd:$/ { pid = substr($0, 7, length($0) - 10) } /socket:\\[[0-9]+\\]$/ { print pid, $NF }'"
// One C walk in the port-scan worker replaces ~one readlink promise per fd on Electron main; ls gets directory
// arguments (one per process, not per fd) so a busy machine cannot exceed the exec argument limit.
const SOCKET_LISTING_SCRIPT = `ls -ln /proc/[0-9]*/fd 2>/dev/null | ${SOCKET_HOLDER_AWK}`

/** Map listening socket inodes to the pid a full /proc walk keeps: the last holder in /proc's listing order. */
export async function resolveLinuxSocketOwners(inodes: Set<number>): Promise<Map<number, number>> {
  if (inodes.size === 0) {
    return new Map()
  }
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))
  } catch {
    return new Map()
  }
  const listing = await runPortScanCommand('/bin/sh', ['-c', SOCKET_LISTING_SCRIPT]).catch(
    () => null
  )
  if (listing === null) {
    return walkProcSocketOwners(pids, inodes)
  }
  return pickLastHolders(parseSocketHolderListing(listing.stdout), pids, inodes)
}

/** Lines of `<pid> socket:[<inode>]` from the listing script. */
export function parseSocketHolderListing(output: string): { pid: number; inode: number }[] {
  const holders: { pid: number; inode: number }[] = []
  for (const line of output.split('\n')) {
    const match = /^(\d+) socket:\[(\d+)\]$/.exec(line.trim())
    if (match) {
      holders.push({ pid: Number(match[1]), inode: Number(match[2]) })
    }
  }
  return holders
}

/** Keep, per inode, the holder a walk in `pidOrder` would visit last; pids that appeared after the listing go last. */
export function pickLastHolders(
  holders: readonly { pid: number; inode: number }[],
  pidOrder: readonly string[],
  inodes: Set<number>
): Map<number, number> {
  const rank = new Map(pidOrder.map((pid, index) => [Number(pid), index]))
  const rankOf = (pid: number): number => rank.get(pid) ?? pidOrder.length + pid
  const result = new Map<number, number>()
  for (const { pid, inode } of holders) {
    const current = result.get(inode)
    if (inodes.has(inode) && (current === undefined || rankOf(pid) > rankOf(current))) {
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
