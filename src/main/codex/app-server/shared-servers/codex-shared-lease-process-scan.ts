import { readdir, readFile, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { enumerateHostProcesses } from '../../../memory/host-process-index'
import { collectSubtree, type ProcIndex } from '../../../memory/process-index'
import { spawnTokenFromEnvironBlock } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'

const PS_TIMEOUT_MS = 5_000
const PS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const UNREADABLE_TAG = Symbol('unreadable')

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
    return scanLinux(envName, serverPid)
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

/** Parent pid from /proc/<pid>/stat; the name field may hold spaces or parens, so read after it. */
function parentFromStat(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const parent = Number(fields[1])
  return Number.isSafeInteger(parent) ? parent : null
}

/** The launcher is a subreaper on Linux, so every command a chat orphaned is still under it and
 *  only that tree is judged (another app's unreadable process proves nothing here). Without the
 *  launcher, an orphan goes to init, so every own-user process is judged. */
async function scanLinux(
  envName: string,
  serverPid: number
): Promise<CodexLeaseProcessScan | null> {
  let names: string[]
  try {
    names = await readdir('/proc')
  } catch {
    return null
  }
  const launcher = await readFile(`/proc/${serverPid}/comm`, 'utf-8').catch(() => '')
  const scoped = launcher.startsWith('orca-provider-ex')
  const uid = process.getuid?.()
  const parents = new Map<number, number | null>()
  const tags = new Map<number, string | null | typeof UNREADABLE_TAG>()
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
      if (scoped) {
        const procStat = await readFile(`/proc/${pid}/stat`, 'utf-8').catch(() => null)
        parents.set(pid, procStat === null ? null : parentFromStat(procStat))
      }
      try {
        tags.set(
          pid,
          spawnTokenFromEnvironBlock(await readFile(`/proc/${pid}/environ`, 'utf-8'), envName)
        )
      } catch (error) {
        if (errnoCodeOrUnknown(error) !== 'ENOENT') {
          tags.set(pid, UNREADABLE_TAG)
        }
      }
    })
  )
  const inScope = scoped ? linuxSubtree(parents, serverPid) : null
  const entries: (readonly [number, string | null])[] = []
  const unreadable: number[] = []
  for (const [pid, tag] of tags) {
    if (inScope && !inScope(pid)) {
      continue
    }
    if (tag === UNREADABLE_TAG) {
      unreadable.push(pid)
    } else {
      entries.push([pid, tag])
    }
  }
  return { tagged: byTag(entries), unreadable }
}

/** Whether a pid sits under the server; one whose parent couldn't be read counts as under it. */
function linuxSubtree(
  parents: ReadonlyMap<number, number | null>,
  serverPid: number
): (pid: number) => boolean {
  const verdicts = new Map<number, boolean>()
  return (pid) => {
    const path: number[] = []
    let at: number | null | undefined = pid
    let result = false
    for (;;) {
      if (at === serverPid || at === null) {
        result = true
        break
      }
      const known = at === undefined ? undefined : verdicts.get(at)
      if (known !== undefined) {
        result = known
        break
      }
      if (at === undefined || !parents.has(at) || path.length > parents.size) {
        break
      }
      path.push(at)
      at = parents.get(at)
    }
    for (const visited of path) {
      verdicts.set(visited, result)
    }
    return result
  }
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
