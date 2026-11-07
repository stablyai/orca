import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { commandContainsToken } from '../../shared/command-token-scanner'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'
import { PS_MAX_BUFFER_BYTES } from '../../shared/process-table-snapshot'

export type ServeSimHelperProcess = {
  pid: number
  command: string
}

const SERVE_SIM_DETACHED_HELPER_FLAG = '--exit-on-simulator-shutdown'

type ServeSimHelperProcessLookupOptions = {
  helperPid?: number
  includeOrphaned?: boolean
}

function readPs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      args,
      { timeout: 5_000, maxBuffer: PS_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        // `ps -p` exits 1 silently when the PID is gone; anything else is a failed read, not an absent helper.
        if (error && !(error.code === 1 && stdout.length === 0 && stderr.length === 0)) {
          reject(error)
          return
        }
        resolve(stdout.toString())
      }
    )
  })
}

// Why: serve-sim >= 0.1.47 hosts the helper in node; keep serve-sim-bin so a pre-update helper is still reaped.
function isServeSimHelperCommand(command: string): boolean {
  if (/(^|\/)serve-sim-bin(?:\s|$)/.test(command)) {
    return true
  }
  return (
    commandContainsToken(command, SERVE_SIM_DETACHED_HELPER_FLAG) &&
    /(^|\/)serve-sim(?:\.js)?\s/.test(command)
  )
}

export function parseServeSimHelperProcesses(psOutput: string): ServeSimHelperProcess[] {
  const helpers: ServeSimHelperProcess[] = []
  for (const line of iterateProcessOutputLines(psOutput)) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (!Number.isInteger(pid) || !isServeSimHelperCommand(command)) {
      continue
    }
    helpers.push({ pid, command })
  }
  return helpers
}

function commandTargetsDevice(command: string, deviceUdid: string): boolean {
  return commandContainsToken(command, deviceUdid)
}

export async function listServeSimHelperProcessesForDevice(
  deviceUdid: string,
  options: ServeSimHelperProcessLookupOptions = {}
): Promise<ServeSimHelperProcess[]> {
  if (platform() !== 'darwin') {
    return []
  }
  // The known PID is checked alone so attach never depends on reading the whole process table.
  const args =
    options.includeOrphaned === true
      ? ['-axo', 'pid=,command=']
      : options.helperPid !== undefined
        ? ['-p', String(options.helperPid), '-o', 'pid=,command=']
        : null
  if (!args) {
    return []
  }
  return parseServeSimHelperProcesses(await readPs(args)).filter((helper) =>
    commandTargetsDevice(helper.command, deviceUdid)
  )
}

export async function killServeSimHelperProcessesForDevice(
  deviceUdid: string,
  options: ServeSimHelperProcessLookupOptions = {}
): Promise<void> {
  const helperPids = (await listServeSimHelperProcessesForDevice(deviceUdid, options)).map(
    (helper) => helper.pid
  )

  for (const pid of new Set(helperPids)) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Best effort; serve-sim's own --kill remains the authoritative path.
    }
  }
}
