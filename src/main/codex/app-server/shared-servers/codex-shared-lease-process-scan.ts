import { readdir, readFile, stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
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
    return scanDarwin(envName, serverPid)
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
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          unreadable.push(pid)
        }
      }
    })
  )
  return { tagged: byTag(entries), unreadable }
}

async function ps(
  withEnvironment: boolean,
  pids: readonly number[]
): Promise<Map<number, string> | null> {
  const result = await runProcess({
    program: 'ps',
    args: [...(withEnvironment ? ['-E'] : []), '-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
    timeoutMs: PS_TIMEOUT_MS,
    maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  }).catch(() => null)
  // ps exits 1 when some listed pid is gone; the rest of its output still stands.
  if (
    !result ||
    result.timedOut ||
    result.outputTruncated ||
    (result.code !== 0 && result.code !== 1)
  ) {
    return null
  }
  const lines = new Map<number, string>()
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+) (.*)$/.exec(line)
    if (match) {
      lines.set(Number(match[1]), match[2]!)
    }
  }
  return lines
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

/** macOS has no subreaper, so a dedicated server's close could only ever reach its current tree;
 *  the shared one is held to the same boundary. `ps -E` prints the environment after the
 *  arguments with no boundary, and hides it entirely for Apple's own binaries (sh, sleep...), so
 *  the arguments are read first and only text after them counts; a process whose environment
 *  isn't shown, or whose readings don't line up, is unreadable rather than guessed at. */
async function scanDarwin(
  envName: string,
  serverPid: number
): Promise<CodexLeaseProcessScan | null> {
  const index = await enumerateHostProcesses({ trackCpu: false, withNames: true })
  if (!index.byPid.has(serverPid)) {
    return null
  }
  const chain = serverChain(index, serverPid)
  if (!chain) {
    return null
  }
  const candidates = collectSubtree(index, serverPid).filter((pid) => !chain.has(pid))
  if (candidates.length === 0) {
    return { tagged: () => [], unreadable: [] }
  }
  const argv = await ps(false, candidates)
  const full = argv ? await ps(true, candidates) : null
  if (!argv || !full) {
    return null
  }
  const entries: (readonly [number, string | null])[] = []
  const unreadable: number[] = []
  for (const [pid, line] of full) {
    const args = argv.get(pid)
    const environment = args !== undefined && line.startsWith(args) ? line.slice(args.length) : ''
    if (!environment.trim()) {
      unreadable.push(pid)
      continue
    }
    const tags = environment
      .split(' ')
      .filter((token) => token.startsWith(`${envName}=`))
      .map((token) => token.slice(envName.length + 1))
    if (tags.length > 1) {
      unreadable.push(pid)
    } else {
      entries.push([pid, tags[0] ?? null])
    }
  }
  return { tagged: byTag(entries), unreadable }
}
