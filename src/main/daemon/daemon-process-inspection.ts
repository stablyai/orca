import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { parseLinuxBootTimeSeconds, parseLinuxProcStartTicks } from './daemon-process-start-time'
import type {
  LinuxStatEvidence,
  ProcessLivenessVerdict,
  ProcessSignalEvidence,
  WindowsProcessEvidence
} from './daemon-incarnation-evidence-types'
import {
  readWindowsProcessCreationTime,
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'

const execFileAsync = promisify(execFile)

type InspectionCommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>

export type DaemonProcessInspectionDependencies = {
  readTextFile?: (path: string) => Promise<string>
  runCommand?: InspectionCommandRunner
  readProcessTable?: () => Promise<WindowsProcessRow[]>
}

export function inspectProcessSignal(pid: number): ProcessSignalEvidence {
  try {
    process.kill(pid, 0)
    return 'occupied'
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return 'missing'
    }
    if (hasErrorCode(error, 'EPERM')) {
      return 'permission_denied'
    }
    return 'unavailable'
  }
}

/** EPERM counts as alive: it proves some process holds the PID. */
export function isProcessAlive(pid: number): boolean {
  const signal = inspectProcessSignal(pid)
  return signal === 'occupied' || signal === 'permission_denied'
}

export function inspectProcessLiveness(pid: number): ProcessLivenessVerdict {
  const signal = inspectProcessSignal(pid)
  switch (signal) {
    case 'occupied':
    case 'permission_denied':
      return { status: 'live' }
    case 'missing':
      return { status: 'exited' }
    case 'unavailable':
      return { status: 'unverifiable', reason: 'the daemon process could not be queried' }
  }
}

export function mergeProcessLivenessVerdict(
  current: ProcessLivenessVerdict | undefined,
  next: ProcessLivenessVerdict
): ProcessLivenessVerdict {
  switch (next.status) {
    case 'live':
      return next
    case 'unverifiable':
      return current?.status === 'live' ? current : next
    case 'exited':
      return current ?? next
  }
}

export async function readLinuxStat(pid: number): Promise<LinuxStatEvidence> {
  try {
    return { status: 'present', value: await readFile(`/proc/${pid}/stat`, 'utf8') }
  } catch (error) {
    return { status: hasErrorCode(error, 'ENOENT') ? 'missing' : 'unavailable' }
  }
}

export async function readProcessCommandLine(
  pid: number,
  platform: NodeJS.Platform,
  dependencies: DaemonProcessInspectionDependencies = {}
): Promise<string | undefined> {
  const readTextFile =
    dependencies.readTextFile ?? (async (path: string) => await readFile(path, 'utf8'))
  const runCommand = dependencies.runCommand ?? runInspectionCommand
  if (platform === 'linux') {
    try {
      const procCommandLine = await readTextFile(`/proc/${pid}/cmdline`)
      if (procCommandLine.length > 0) {
        return procCommandLine
      }
    } catch {
      // Fall through to ps for procfs privilege or mount restrictions.
    }
  }
  try {
    const stdout = await runCommand('ps', ['-p', String(pid), '-o', 'command='], 2_000)
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

// Only a table that was read and lacks the PID proves absence; the reader rejects a truncated one.
export async function queryWindowsProcess(
  pid: number,
  dependencies: DaemonProcessInspectionDependencies = {}
): Promise<WindowsProcessEvidence> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'unavailable' }
  }
  let rows: WindowsProcessRow[]
  try {
    rows = await (dependencies.readProcessTable ?? readWindowsProcessTableFresh)()
  } catch {
    return { status: 'unavailable' }
  }
  const row = rows.find((candidate) => candidate.pid === pid)
  if (!row) {
    return { status: 'missing' }
  }
  return {
    status: 'present',
    commandLine: row.command || null,
    startedAtMs: row.creationTimeMs ?? readWindowsProcessCreationTime(pid)
  }
}

// Why: the sync procfs helper in daemon-process-start-time spawns getconf per call; CLK_TCK is fixed for
// the kernel's lifetime, so cache one async spawn and only retry after a failure. The cache is
// keyed by runner because CLK_TCK belongs to the host that executes the command, not the module.
const clockTicksPerSecondByRunner = new WeakMap<InspectionCommandRunner, Promise<number | null>>()

async function readClockTicksPerSecond(
  runCommand: InspectionCommandRunner
): Promise<number | null> {
  let pending = clockTicksPerSecondByRunner.get(runCommand)
  if (!pending) {
    pending = runCommand('getconf', ['CLK_TCK'], 1_000).then(
      (stdout) => {
        const ticks = Number(stdout.trim())
        return Number.isFinite(ticks) && ticks > 0 ? ticks : null
      },
      () => null
    )
    clockTicksPerSecondByRunner.set(runCommand, pending)
  }
  const ticksPerSecond = await pending
  if (ticksPerSecond === null && clockTicksPerSecondByRunner.get(runCommand) === pending) {
    clockTicksPerSecondByRunner.delete(runCommand)
  }
  return ticksPerSecond
}

// Why: same main-thread hazard as darwin — the sync linux helper does two readFileSync calls
// plus a getconf spawn, and this audit-only probe runs in the Electron main process.
export async function readLinuxProcessStartedAtMs(
  pid: number,
  dependencies: DaemonProcessInspectionDependencies = {}
): Promise<number | null> {
  const readTextFile =
    dependencies.readTextFile ?? (async (path: string) => await readFile(path, 'utf8'))
  try {
    const startTicks = parseLinuxProcStartTicks(await readTextFile(`/proc/${pid}/stat`))
    const bootTimeSeconds = parseLinuxBootTimeSeconds(await readTextFile('/proc/stat'))
    const ticksPerSecond = await readClockTicksPerSecond(
      dependencies.runCommand ?? runInspectionCommand
    )
    if (
      ticksPerSecond === null ||
      !Number.isFinite(startTicks) ||
      !Number.isFinite(bootTimeSeconds)
    ) {
      return null
    }
    return bootTimeSeconds * 1000 + (startTicks / ticksPerSecond) * 1000
  } catch {
    return null
  }
}

// Why: `ps` is darwin's only start-time source and this audit-only probe runs in the
// Electron main process, where the sync spawn blocks every IPC/UI turn for its duration.
export async function readMacosProcessStartedAtMs(
  pid: number,
  dependencies: DaemonProcessInspectionDependencies = {}
): Promise<number | null> {
  const runCommand = dependencies.runCommand ?? runInspectionCommand
  try {
    const stdout = await runCommand('ps', ['-p', String(pid), '-o', 'lstart='], 2_000)
    const startedAtMs = Date.parse(stdout.trim())
    return Number.isFinite(startedAtMs) ? startedAtMs : null
  } catch {
    return null
  }
}

async function runInspectionCommand(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })
  return stdout
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
