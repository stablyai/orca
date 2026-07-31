import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type {
  LinuxStatEvidence,
  ProcessSignalEvidence,
  WindowsProcessEvidence
} from './daemon-incarnation-evidence-types'

const execFileAsync = promisify(execFile)

export type DaemonProcessInspectionDependencies = {
  readTextFile?: (path: string) => Promise<string>
  runCommand?: (file: string, args: string[], timeoutMs: number) => Promise<string>
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

export async function queryWindowsProcess(
  pid: number,
  dependencies: DaemonProcessInspectionDependencies = {}
): Promise<WindowsProcessEvidence> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { status: 'unavailable' }
  }
  const runCommand = dependencies.runCommand ?? runInspectionCommand
  try {
    const stdout = await runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          `if (!$p) { @{ exists = $false } | ConvertTo-Json -Compress } else { ` +
          `$start = $null; if ($p.CreationDate) { ` +
          `$start = [long]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }; ` +
          `@{ exists = $true; cmd = $p.CommandLine; start = $start } | ConvertTo-Json -Compress }`
      ],
      3_000
    )
    const parsed = JSON.parse(stdout.trim()) as {
      exists?: unknown
      cmd?: unknown
      start?: unknown
    }
    if (parsed.exists === false) {
      return { status: 'missing' }
    }
    if (parsed.exists !== true) {
      return { status: 'unavailable' }
    }
    return {
      status: 'present',
      commandLine: typeof parsed.cmd === 'string' && parsed.cmd ? parsed.cmd : null,
      startedAtMs:
        typeof parsed.start === 'number' && Number.isFinite(parsed.start) ? parsed.start : null
    }
  } catch {
    return { status: 'unavailable' }
  }
}

async function runInspectionCommand(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { encoding: 'utf8', timeout: timeoutMs })
  return stdout
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
