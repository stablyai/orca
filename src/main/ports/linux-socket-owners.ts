import { readdir, readlink } from 'node:fs/promises'
import { runPortScanCommand } from './port-scan-command-client'

/**
 * Turns `ls -ln` directory listings into `<pid> socket:[<inode>]` lines for the inodes in $1 (",1,2,"), then
 * `seen <n>`: every well-formed socket line, so a format it can't read is told apart from no wanted holders.
 */
export const SOCKET_HOLDER_AWK = `awk -v want="$1" '
/^\\/proc\\/[0-9]+\\/fd:$/ { pid = substr($0, 7, length($0) - 10); next }
NF >= 2 && $(NF - 1) == "->" && $NF ~ /^socket:\\[[0-9]+\\]$/ && pid != "" {
  seen++
  if (index(want, "," substr($NF, 9, length($NF) - 9) ",")) print pid, $NF
}
END { print "seen", seen + 0 }'`
// One C walk in the port-scan worker replaces ~one readlink promise per fd on Electron main; ls gets directory
// arguments (one per process, not per fd) so a busy machine cannot exceed the exec argument limit, and awk
// prints only the wanted inodes so output grows with listeners, not with every socket on the system.
const SOCKET_LISTING_SCRIPT = `ls -ln /proc/[0-9]*/fd 2>/dev/null | ${SOCKET_HOLDER_AWK}`

const LISTING_RETRY_SCANS = 9
let scansUntilListingRetry = 0

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
  // After a failed listing, don't pay for it and the walk on every scan; retry it every 10th scan.
  if (scansUntilListingRetry > 0) {
    scansUntilListingRetry -= 1
    return walkProcSocketOwners(pids, inodes)
  }
  const want = `,${[...inodes].join(',')},`
  const listing = await runPortScanCommand('/bin/sh', [
    '-c',
    SOCKET_LISTING_SCRIPT,
    'orca-port-scan',
    want
  ]).catch(() => null)
  const parsed = listing ? parseSocketHolderListing(listing.stdout) : null
  if (!parsed || parsed.seen === 0) {
    scansUntilListingRetry = LISTING_RETRY_SCANS
    return walkProcSocketOwners(pids, inodes)
  }
  return pickLastHolders(parsed.holders, pids, inodes)
}

/** Holder lines and the `seen` total from the listing script; null when the total line is missing (cut short). */
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
