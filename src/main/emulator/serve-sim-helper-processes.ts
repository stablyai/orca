import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { commandContainsToken } from '../../shared/command-token-scanner'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'

export type ServeSimHelperProcess = {
  pid: number
  command: string
}

const SERVE_SIM_DETACHED_HELPER_FLAG = '--exit-on-simulator-shutdown'
export const SERVE_SIM_OWNER_ENV = 'ORCA_SERVE_SIM_OWNER'

type ServeSimHelperProcessLookupOptions = {
  helperPid?: number
  includeOrphaned?: boolean
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout.toString())
    })
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
  const knownPid = options.helperPid
  const includeOrphaned = options.includeOrphaned === true
  const output = await execFileText('ps', ['-axo', 'pid=,command=']).catch(() => '')
  if (!output) {
    return []
  }
  return parseServeSimHelperProcesses(output).filter((helper) => {
    if (knownPid !== undefined && helper.pid === knownPid) {
      return true
    }
    return includeOrphaned && commandTargetsDevice(helper.command, deviceUdid)
  })
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

export async function killOwnedServeSimHelperProcessesForDevice(
  deviceUdid: string,
  ownerId: string
): Promise<void> {
  if (platform() !== 'darwin' || !ownerId) {
    return
  }
  const table = await execFileText('ps', ['-axo', 'pid=,command=']).catch(() => '')
  const helpers = parseServeSimHelperProcesses(table).filter((helper) =>
    containsExactToken(helper.command, deviceUdid)
  )
  const counts = new Map<number, number>()
  for (const line of iterateProcessOutputLines(table)) {
    const pidMatch = /^\s*(\d+)\s/.exec(line)
    if (pidMatch) {
      const pid = Number(pidMatch[1])
      counts.set(pid, (counts.get(pid) ?? 0) + 1)
    }
  }
  await Promise.all(
    helpers.map(async ({ pid }) => {
      if (pid <= 0 || counts.get(pid) !== 1) {
        return
      }
      // A shared state-file PID or device match is not proof that Orca launched it.
      const output = await execFileText('ps', [
        '-Eww',
        '-p',
        String(pid),
        '-o',
        'pid=,command='
      ]).catch(() => '')
      const current = parseServeSimHelperProcesses(output)
      const helper = current[0]
      let rowCount = 0
      for (const line of iterateProcessOutputLines(output)) {
        if (line.trim()) {
          rowCount += 1
        }
      }
      if (
        rowCount !== 1 ||
        current.length !== 1 ||
        helper?.pid !== pid ||
        !containsExactToken(helper.command, deviceUdid) ||
        !containsExactToken(helper.command, `${SERVE_SIM_OWNER_ENV}=${ownerId}`)
      ) {
        return
      }
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The owned helper may already have exited.
      }
    })
  )
}

function containsExactToken(command: string, token: string): boolean {
  const index = command.indexOf(token)
  if (index === -1) {
    return false
  }
  // Inspect both token boundaries even beyond the command scanner's 4 KiB bound.
  return commandContainsToken(
    command.slice(Math.max(0, index - 1), index + token.length + 1),
    token
  )
}
