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
 *  couldn't be read, so a scan with any is no proof that a lease's commands are gone.
 *  `bounded`: false when an untagged orphan of a chat could exist outside the scan's view, so
 *  finding no tagged process proves nothing. */
export type CodexLeaseProcessScan = {
  tagged: (leaseId: string) => number[]
  unreadable: number[]
  bounded: boolean
}

/** null when the processes can't be read at all, or on a platform with no way to read a process's
 *  environment (Windows, where a shared chat's Stop judges only what Codex tracks). */
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

type LinuxProcess = { parent: number | null; name: string }

/** Name and parent from /proc/<pid>/stat; the name may hold spaces or parens, so split on the last. */
function parseStat(stat: string): LinuxProcess {
  const close = stat.lastIndexOf(')')
  const parent = Number(stat.slice(close + 2).split(' ')[1])
  return {
    name: stat.slice(stat.indexOf('(') + 1, close),
    parent: Number.isSafeInteger(parent) ? parent : null
  }
}

// Linux keeps 15 characters of a process name, so `orca-provider-exec` reads `orca-provider-e`.
const isLauncherName = (name: string | undefined): boolean =>
  (name ?? '').startsWith('orca-provider-e')

/** Own-user processes with their parent and name; null when /proc can't be listed. */
async function readOwnLinuxProcesses(): Promise<Map<number, LinuxProcess> | null> {
  let names: string[]
  try {
    names = await readdir('/proc')
  } catch {
    return null
  }
  const uid = process.getuid?.()
  const processes = new Map<number, LinuxProcess>()
  await Promise.all(
    names.map(async (name) => {
      const pid = Number(name)
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
        return
      }
      try {
        // A chat's commands run as this user; another user's process can't be one of them.
        if (uid !== undefined && (await stat(`/proc/${pid}`)).uid !== uid) {
          return
        }
        processes.set(pid, parseStat(await readFile(`/proc/${pid}/stat`, 'utf-8')))
      } catch {
        // Exited mid-scan.
      }
    })
  )
  return processes
}

async function readLinuxTags(
  pids: readonly number[],
  envName: string
): Promise<Map<number, string | null | typeof UNREADABLE_TAG>> {
  const tags = new Map<number, string | null | typeof UNREADABLE_TAG>()
  await Promise.all(
    pids.map(async (pid) => {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, 'utf-8')
        tags.set(pid, spawnTokenFromEnvironBlock(environ, envName))
      } catch (error) {
        if (errnoCodeOrUnknown(error) !== 'ENOENT') {
          tags.set(pid, UNREADABLE_TAG)
        }
      }
    })
  )
  return tags
}

/** The published server pid is the Codex leader the launcher exec'd; the launcher above it is a
 *  subreaper, so every process a chat's commands orphaned is still under the launcher. Inside it,
 *  a process belongs to the chat whose tag it or its nearest ancestor below Codex carries (a
 *  command that cleared its environment still sits under the tagged command that started it).
 *  An untagged process under no tagged one is Codex's own (an MCP server); an untagged orphan
 *  can't be attributed, so no chat's Stop is proven while it runs. Without the launcher, orphans
 *  go to init, so tagged processes are stopped but nothing is proven. */
async function scanLinux(
  envName: string,
  serverPid: number
): Promise<CodexLeaseProcessScan | null> {
  const processes = await readOwnLinuxProcesses()
  if (!processes) {
    return null
  }
  const server = processes.get(serverPid)
  const launcher = isLauncherName(server?.name)
    ? serverPid
    : server?.parent != null && isLauncherName(processes.get(server.parent)?.name)
      ? server.parent
      : null
  if (launcher === null) {
    // Tagged processes can still be found and stopped, but a command that cleared its environment
    // and was orphaned to init is indistinguishable from any other process.
    const tags = await readLinuxTags([...processes.keys()], envName)
    const unreadable = [...tags].flatMap(([pid, tag]) => (tag === UNREADABLE_TAG ? [pid] : []))
    const entries = [...tags].flatMap(([pid, tag]) =>
      tag === UNREADABLE_TAG ? [] : [[pid, tag] as const]
    )
    return { tagged: byTag(entries), unreadable, bounded: false }
  }
  const children = new Map<number, number[]>()
  for (const [pid, { parent }] of processes) {
    if (parent !== null) {
      const siblings = children.get(parent)
      if (siblings) {
        siblings.push(pid)
      } else {
        children.set(parent, [pid])
      }
    }
  }
  const watchers = new Set(
    (children.get(launcher) ?? []).filter((pid) => isLauncherName(processes.get(pid)?.name))
  )
  const roots = new Set(
    launcher === serverPid
      ? (children.get(launcher) ?? []).filter((pid) => !watchers.has(pid))
      : [serverPid]
  )
  const scope = linuxDescendants(children, launcher)
  const tags = await readLinuxTags(scope, envName)
  const attached = new Set(
    [...roots].flatMap((root) => [root, ...linuxDescendants(children, root)])
  )
  const owners = new Map<number, string | null | typeof UNREADABLE_TAG>()
  const ownerOf = (pid: number): string | null | typeof UNREADABLE_TAG => {
    const known = owners.get(pid)
    if (known !== undefined) {
      return known
    }
    const own = tags.get(pid) ?? null
    const parent = processes.get(pid)?.parent ?? null
    const owner =
      own !== null || roots.has(pid) || parent === null || !attached.has(parent)
        ? own
        : ownerOf(parent)
    owners.set(pid, owner)
    return owner
  }
  const entries: (readonly [number, string | null])[] = []
  const unreadable: number[] = []
  for (const pid of scope) {
    if (watchers.has(pid)) {
      continue
    }
    const owner = ownerOf(pid)
    if (owner === UNREADABLE_TAG || (owner === null && !attached.has(pid))) {
      unreadable.push(pid)
    } else {
      entries.push([pid, owner])
    }
  }
  return { tagged: byTag(entries), unreadable, bounded: true }
}

/** Every process below one, by parent links. */
function linuxDescendants(children: ReadonlyMap<number, number[]>, root: number): number[] {
  const found: number[] = []
  const queue = [...(children.get(root) ?? [])]
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]!
    found.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return found
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
export function serverChain(index: ProcIndex, serverPid: number): Set<number> | null {
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
      if (isLauncherName(index.byPid.get(child)?.name)) {
        infrastructure.add(child)
      }
    }
  }
  const members = [...groups].flatMap(([pid, group]) => (owned.has(group) ? [pid] : []))
  const others = [...new Set([...collectSubtree(index, serverPid), ...members])].filter(
    (pid) => !infrastructure.has(pid)
  )
  return { tagged: () => [], unreadable: others, bounded: true }
}
