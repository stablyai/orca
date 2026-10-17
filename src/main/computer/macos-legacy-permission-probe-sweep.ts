import { tmpdir } from 'node:os'
import { runProcess } from '@orca/process-host'
import { escapeRegex } from '../../shared/string-utils'

// Why this file exists: Orca versions before the provider-backed status read launched one
// LaunchServices probe app per permission check, and probes created after their one-shot pkill
// stay suspended forever. This only clears those leftovers; delete it once those versions age out.

// `executable` is argv[0] (ps comm); reading it apart from `command` is what keeps a process
// that merely mentions the probe path in its arguments from matching.
type ProcessRow = {
  pid: number
  parentPid: number
  uid: number
  executable: string
  command: string
}

export type LegacyPermissionProbeSweepDeps = {
  readProcesses?: () => Promise<ProcessRow[]>
  signal?: (pid: number) => void
  tmpRoot?: string
  uid?: number
}

const HELPER_EXECUTABLE = /^\/.*\.app\/Contents\/MacOS\/orca-computer-use-macos$/

export function isLegacyPermissionStatusProbe(
  row: ProcessRow,
  tmpRoot: string,
  uid: number
): boolean {
  // Why ppid 1: probes were launched by LaunchServices, so launchd is their parent.
  if (row.uid !== uid || row.parentPid !== 1 || !HELPER_EXECUTABLE.test(row.executable)) {
    return false
  }
  if (!row.command.startsWith(`${row.executable} `)) {
    return false
  }
  const args = row.command.slice(row.executable.length + 1)
  return new RegExp(
    `^--permission-status-file ${escapeRegex(tmpRoot)}/orca-computer-use-permissions-[A-Za-z0-9]{6}/status\\.json$`
  ).test(args)
}

async function readPs(args: string[]): Promise<string[]> {
  const result = await runProcess({
    program: '/bin/ps',
    args,
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: 5_000,
    maxOutputBytes: 8 * 1024 * 1024,
    killOnOutputLimit: true
  })
  // ps exits 1 when a listed pid has since exited.
  if (result.timedOut || result.outputTruncated || (result.code !== 0 && result.code !== 1)) {
    throw new Error('Could not list processes for the permission probe sweep')
  }
  return result.stdout.split('\n')
}

export async function readLaunchdChildHelperProcesses(): Promise<ProcessRow[]> {
  const candidates = (await readPs(['-axww', '-o', 'pid=,ppid=,uid=,comm='])).flatMap((line) => {
    // comm is last, so spaces inside the bundle path stay intact.
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\/.*?)\s*$/.exec(line)
    return match && match[2] === '1' && HELPER_EXECUTABLE.test(match[4])
      ? [{ pid: Number(match[1]), parentPid: 1, uid: Number(match[3]), executable: match[4] }]
      : []
  })
  if (candidates.length === 0) {
    return []
  }
  const pids = candidates.map((candidate) => candidate.pid).join(',')
  const commands = new Map<number, string>()
  for (const line of await readPs(['-ww', '-p', pids, '-o', 'pid=,command='])) {
    const match = /^\s*(\d+)\s(.*?)\s*$/.exec(line)
    if (match) {
      commands.set(Number(match[1]), match[2].trimStart())
    }
  }
  return candidates.flatMap((candidate) => {
    const command = commands.get(candidate.pid)
    return command === undefined ? [] : [{ ...candidate, command }]
  })
}

export async function sweepLegacyPermissionStatusProbes(
  deps: LegacyPermissionProbeSweepDeps = {}
): Promise<number[]> {
  const uid = deps.uid ?? process.getuid?.()
  if (process.platform !== 'darwin' || uid === undefined) {
    return []
  }
  const tmpRoot = deps.tmpRoot ?? tmpdir()
  const rows = await (deps.readProcesses ?? readLaunchdChildHelperProcesses)()
  // Why SIGKILL: the probes are suspended (state T) and hold nothing worth a graceful exit.
  const signal = deps.signal ?? ((pid: number) => process.kill(pid, 'SIGKILL'))
  const killed: number[] = []
  for (const row of rows) {
    if (!isLegacyPermissionStatusProbe(row, tmpRoot, uid)) {
      continue
    }
    try {
      signal(row.pid)
      killed.push(row.pid)
    } catch {
      // Already gone.
    }
  }
  return killed
}
