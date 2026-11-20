import { readdir, readFile, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { enumerateHostProcesses } from '../../../memory/host-process-index'
import { collectSubtree, type ProcIndex } from '../../../memory/process-index'
import { spawnTokenFromEnvironBlock } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'

const PS_TIMEOUT_MS = 5_000
const PS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** This user's processes by their lease tag. `unreadable`: own processes whose environment
 *  couldn't be read, so a scan with any is no proof that a lease's commands are gone. */
export type CodexLeaseProcessScan = {
  tagged: (leaseId: string) => number[]
  unreadable: number[]
}

/** null when the processes can't be read at all, or on a platform with no way to read a process's
 *  environment (Windows, where the pool isn't used). */
export async function scanCodexLeaseProcesses(
  envName: string,
  serverPid: number,
  platform: NodeJS.Platform = process.platform
): Promise<CodexLeaseProcessScan | null> {
  if (platform === 'linux') {
    // Linux reads every own-user process, so a command reparented anywhere is still found.
    return scanLinux(envName)
  }
  if (platform === 'darwin') {
    return scanDarwin(serverPid)
  }
  return null
}

function byTag(entries: readonly (readonly [number, string | null])[]) {
  return (leaseId: string): number[] =>
    entries.flatMap(([pid, tag]) => (tag === leaseId ? [pid] : []))
}

async function scanLinux(envName: string): Promise<CodexLeaseProcessScan | null> {
  let names: string[]
  try {
    names = await readdir('/proc')
  } catch {
    return null
  }
  const uid = process.getuid?.()
  const entries: (readonly [number, string | null])[] = []
  const unreadable: number[] = []
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(name)
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
        return
      }
      let owner: number
      try {
        owner = (await stat(`/proc/${pid}`)).uid
      } catch {
        return // Exited mid-scan.
      }
      // A chat's commands run as this user; another user's process can't carry its tag.
      if (uid !== undefined && owner !== uid) {
        return
      }
      try {
        entries.push([
          pid,
          spawnTokenFromEnvironBlock(await readFile(`/proc/${pid}/environ`, 'utf-8'), envName)
        ])
      } catch (error) {
        if (errnoCodeOrUnknown(error) !== 'ENOENT') {
          unreadable.push(pid)
        }
      }
    })
  )
  return { tagged: byTag(entries), unreadable }
}

/** Every process's group, for the boundary a dedicated server's watcher owned on macOS. */
async function processGroups(): Promise<Map<number, number> | null> {
  const result = await runProcess({
    program: 'ps',
    args: ['-A', '-o', 'pid=,pgid='],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  }).catch(() => null)
  if (!result || result.timedOut || result.outputTruncated || result.code !== 0) {
    return null
  }
  const groups = new Map<number, number>()
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) {
      groups.set(Number(match[1]), Number(match[2]))
    }
  }
  return groups
}

/** The server's launcher chain down to the native Codex process; null when Codex isn't found. */
function serverChain(index: ProcIndex, serverPid: number): Set<number> | null {
  const parents = new Map<number, number>()
  const queue = [serverPid]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (/^codex/i.test(index.byPid.get(pid)?.name ?? '')) {
      const chain = new Set<number>()
      for (let at: number | undefined = pid; at !== undefined; at = parents.get(at)) {
        chain.add(at)
      }
      return chain
    }
    for (const child of index.childrenOf.get(pid) ?? []) {
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
async function scanDarwin(serverPid: number): Promise<CodexLeaseProcessScan | null> {
  const index = await enumerateHostProcesses({ trackCpu: false, withNames: true })
  if (!index.byPid.has(serverPid)) {
    return null
  }
  const chain = serverChain(index, serverPid)
  const groups = chain ? await processGroups() : null
  if (!chain || !groups) {
    return null
  }
  // Only a group the server's chain leads is the server's (the launcher starts the CLI in its own
  // session); a group it merely inherited belongs to whoever spawned it.
  const owned = new Set(
    [...chain].flatMap((pid) => {
      const group = groups.get(pid)
      return group !== undefined && chain.has(group) ? [group] : []
    })
  )
  // The launcher's owner-pipe watcher sits beside the chain: infrastructure, not a chat's work.
  const infrastructure = new Set(chain)
  for (const pid of chain) {
    for (const child of index.childrenOf.get(pid) ?? []) {
      if ((index.byPid.get(child)?.name ?? '').startsWith('orca-provider-ex')) {
        infrastructure.add(child)
      }
    }
  }
  const members = [...groups].flatMap(([pid, group]) => (owned.has(group) ? [pid] : []))
  const others = [...new Set([...collectSubtree(index, serverPid), ...members])].filter(
    (pid) => !infrastructure.has(pid)
  )
  return { tagged: () => [], unreadable: others }
}
