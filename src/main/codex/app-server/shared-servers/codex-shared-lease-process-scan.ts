import { readdir, readFile, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { errnoCodeOrUnknown } from '../../../../shared/errors/errno-code'
import { spawnTokenFromEnvironBlock } from '../../../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import {
  childrenByParent,
  coalescedReading,
  descendants
} from './codex-shared-host-process-reading'
import { scanDarwin } from './codex-shared-lease-process-scan-darwin'

/** Bounds the /proc reads in flight, so one walk can't monopolize the fs thread pool. */
const PROC_READ_BATCH = 128
const UNREADABLE_TAG = Symbol('unreadable')
const PS_TIMEOUT_MS = 5_000
const PS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

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
 *  environment (Windows, where the pool isn't used). */
export async function scanCodexLeaseProcesses(
  envName: string,
  serverPid: number,
  platform: NodeJS.Platform = process.platform,
  watcherPid?: number
): Promise<CodexLeaseProcessScan | null> {
  if (platform === 'linux') {
    return scanLinux(envName, serverPid, watcherPid)
  }
  if (platform === 'darwin') {
    return scanDarwin(serverPid, watcherPid)
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

/** Own-user processes with their parent and name, from one `ps` child so Electron main parses one
 *  table instead of walking /proc; the walk is the fallback where ps can't run. */
const readOwnLinuxProcesses = coalescedReading(
  async () => (await readOwnLinuxProcessesWithPs()) ?? (await walkOwnLinuxProcesses())
)

async function readOwnLinuxProcessesWithPs(): Promise<Map<number, LinuxProcess> | null> {
  const uid = process.getuid?.()
  const result = await runProcess({
    program: 'ps',
    args: [...(uid === undefined ? ['-e'] : ['-u', String(uid)]), '-o', 'pid=,ppid=,comm='],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  }).catch(() => null)
  if (!result || result.timedOut || result.outputTruncated || result.code !== 0) {
    return null
  }
  const processes = new Map<number, LinuxProcess>()
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
    const pid = Number(match?.[1])
    if (match && pid !== process.pid) {
      processes.set(pid, { parent: Number(match[2]), name: match[3]! })
    }
  }
  return processes.size > 0 ? processes : null
}

/** Own-user processes with their parent and name; null when /proc can't be listed. */
async function walkOwnLinuxProcesses(): Promise<Map<number, LinuxProcess> | null> {
  let names: string[]
  try {
    names = await readdir('/proc')
  } catch {
    return null
  }
  const uid = process.getuid?.()
  const processes = new Map<number, LinuxProcess>()
  for (let at = 0; at < names.length; at += PROC_READ_BATCH) {
    await Promise.all(
      names.slice(at, at + PROC_READ_BATCH).map(async (name) => {
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
  }
  return processes
}

async function readLinuxTags(
  pids: readonly number[],
  envName: string,
  gone: Set<number>
): Promise<Map<number, string | null | typeof UNREADABLE_TAG>> {
  const tags = new Map<number, string | null | typeof UNREADABLE_TAG>()
  for (let at = 0; at < pids.length; at += PROC_READ_BATCH) {
    await Promise.all(
      pids.slice(at, at + PROC_READ_BATCH).map(async (pid) => {
        try {
          const environ = await readFile(`/proc/${pid}/environ`, 'utf-8')
          tags.set(pid, spawnTokenFromEnvironBlock(environ, envName))
        } catch (error) {
          if (errnoCodeOrUnknown(error) === 'ENOENT') {
            gone.add(pid)
          } else {
            tags.set(pid, UNREADABLE_TAG)
          }
        }
      })
    )
  }
  return tags
}

/** The published server pid is the Codex leader the launcher exec'd; the launcher above it is a
 *  subreaper, so every process a chat's commands orphaned is still under the launcher. Inside it,
 *  a process belongs to the chat whose tag it or its nearest ancestor below Codex carries (a
 *  command that cleared its environment still sits under the tagged command that started it).
 *  An untagged process under no tagged one is Codex's own (an MCP server); an untagged orphan
 *  can't be attributed, so no chat's Stop is proven while it runs. Without the launcher, orphans
 *  go to init, so nothing is proven and nothing is read. */
async function scanLinux(
  envName: string,
  serverPid: number,
  watcherPid: number | undefined
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
    // Orphans go to init here, so nothing can prove a close: no environment is read for nothing.
    return { tagged: () => [], unreadable: [], bounded: false }
  }
  const children = childrenByParent([...processes].map(([pid, { parent }]) => [pid, parent]))
  // The launcher reports its watcher's pid; a command can share the launcher's name.
  const watchers = new Set(
    (children.get(launcher) ?? []).filter(
      (pid) => pid === watcherPid && isLauncherName(processes.get(pid)?.name)
    )
  )
  const roots = new Set(
    launcher === serverPid
      ? (children.get(launcher) ?? []).filter((pid) => !watchers.has(pid))
      : [serverPid]
  )
  const scope = descendants(children, launcher)
  // A process that exited between the two reads leaves its children's ancestry stale.
  const gone = new Set<number>()
  const tags = await readLinuxTags(scope, envName, gone)
  const attached = new Set([...roots].flatMap((root) => [root, ...descendants(children, root)]))
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
        : gone.has(parent)
          ? UNREADABLE_TAG
          : ownerOf(parent)
    owners.set(pid, owner)
    return owner
  }
  const entries: (readonly [number, string | null])[] = []
  const unreadable: number[] = []
  for (const pid of scope) {
    if ((watchers.has(pid) && (tags.get(pid) ?? null) === null) || gone.has(pid)) {
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
