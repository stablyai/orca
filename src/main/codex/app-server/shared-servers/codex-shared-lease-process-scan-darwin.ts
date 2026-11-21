import { runProcess } from '@orca/process-host'
import type { CodexLeaseProcessScan } from './codex-shared-lease-process-scan'
import {
  childrenByParent,
  coalescedReading,
  descendants
} from './codex-shared-host-process-reading'

const PS_TIMEOUT_MS = 5_000
const PS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

type DarwinProcess = { parent: number; group: number; name: string }

/** One `ps` for every process's parent, group and kernel name (ucomm, which a process can't
 *  retitle); null when it can't be read. */
const readDarwinProcesses = coalescedReading(async () => {
  const result = await runProcess({
    program: 'ps',
    args: ['-A', '-o', 'pid=,ppid=,pgid=,ucomm='],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  }).catch(() => null)
  if (!result || result.timedOut || result.outputTruncated || result.code !== 0) {
    return null
  }
  const processes = new Map<number, DarwinProcess>()
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
    if (match) {
      processes.set(Number(match[1]), {
        parent: Number(match[2]),
        group: Number(match[3]),
        name: match[4]!
      })
    }
  }
  return processes
})

/** The server's launcher chain down to the native Codex process; null when Codex isn't found. */
function serverChain(
  processes: ReadonlyMap<number, DarwinProcess>,
  children: ReadonlyMap<number, number[]>,
  serverPid: number
): Set<number> | null {
  const parents = new Map<number, number>()
  const queue = [serverPid]
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]!
    if (/^codex/i.test(processes.get(pid)?.name ?? '')) {
      const chain = new Set<number>()
      for (let at: number | undefined = pid; at !== undefined; at = parents.get(at)) {
        chain.add(at)
      }
      return chain
    }
    for (const child of children.get(pid) ?? []) {
      parents.set(child, pid)
      queue.push(child)
    }
  }
  return null
}

/** macOS gives no trustworthy per-process environment: `ps -E` hides it for Apple's own binaries
 *  and has no boundary between arguments and environment. So nothing is attributed or signalled
 *  here. Every process a dedicated server's close owned (its current tree and the process groups
 *  its watcher held), other than the server's own launcher chain, is reported unreadable: the
 *  chat's Stop is proven only when the server runs nothing else at all. */
export async function scanDarwin(
  serverPid: number,
  isLauncherName: (name: string | undefined) => boolean
): Promise<CodexLeaseProcessScan | null> {
  const processes = await readDarwinProcesses()
  if (!processes?.has(serverPid)) {
    return null
  }
  const children = childrenByParent([...processes].map(([pid, { parent }]) => [pid, parent]))
  const chain = serverChain(processes, children, serverPid)
  if (!chain) {
    return null
  }
  // Only a group the server's chain leads is the server's (the launcher starts the CLI in its own
  // session); a group it merely inherited belongs to whoever spawned it.
  const owned = new Set(
    [...chain].flatMap((pid) => {
      const group = processes.get(pid)?.group
      return group !== undefined && chain.has(group) ? [group] : []
    })
  )
  // The launcher's owner-pipe watcher is a launcher-named child of a launcher (never of Codex) that
  // leads its own process group (provider-exec's run_watcher setpgid(0, 0)): not a chat's work.
  const infrastructure = new Set(chain)
  for (const pid of chain) {
    if (!isLauncherName(processes.get(pid)?.name)) {
      continue
    }
    for (const child of children.get(pid) ?? []) {
      const row = processes.get(child)
      if (isLauncherName(row?.name) && row?.group === child) {
        infrastructure.add(child)
      }
    }
  }
  const members = [...processes].flatMap(([pid, { group }]) => (owned.has(group) ? [pid] : []))
  const others = [...new Set([...descendants(children, serverPid), ...members])].filter(
    (pid) => !infrastructure.has(pid)
  )
  return { tagged: () => [], unreadable: others, bounded: true }
}
