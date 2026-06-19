import { execFile } from 'child_process'
import { platform } from 'os'

export type ServeSimHelperProcess = {
  pid: number
  command: string
}

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

export function parseServeSimHelperProcesses(psOutput: string): ServeSimHelperProcess[] {
  const helpers: ServeSimHelperProcess[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (!Number.isInteger(pid) || !/(^|\/)serve-sim-bin(?:\s|$)/.test(command)) {
      continue
    }
    helpers.push({ pid, command })
  }
  return helpers
}

function commandTargetsDevice(command: string, deviceUdid: string): boolean {
  return command.split(/\s+/).includes(deviceUdid)
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
