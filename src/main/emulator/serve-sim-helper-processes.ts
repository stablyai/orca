import { execFile, spawn } from 'node:child_process'
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

function execFileText(
  command: string,
  args: string[],
  options: { allowEmptySelection?: boolean } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 5_000, maxBuffer: PS_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          if (
            options.allowEmptySelection &&
            error.code === 1 &&
            stdout.length === 0 &&
            stderr.length === 0
          ) {
            resolve('')
            return
          }
          reject(error)
          return
        }
        resolve(stdout.toString())
      }
    )
  })
}

/** Stream orphan cleanup candidates so unrelated process arguments do not hit one aggregate buffer. */
function streamServeSimHelperProcesses(): Promise<ServeSimHelperProcess[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,command='], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const helpers: ServeSimHelperProcess[] = []
    let pending = ''
    let settled = false
    const finishResolve = (value: ServeSimHelperProcess[]): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const finishReject = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      finishReject(new Error('ps timed out'))
    }, 5_000)
    const consume = (chunk: string): void => {
      pending += chunk
      let lineEnd = pending.search(/[\r\n]/)
      while (lineEnd !== -1) {
        const line = pending.slice(0, lineEnd)
        const parsed = parseServeSimHelperProcesses(line)
        helpers.push(...parsed)
        const newlineLength = pending[lineEnd] === '\r' && pending[lineEnd + 1] === '\n' ? 2 : 1
        pending = pending.slice(lineEnd + newlineLength)
        lineEnd = pending.search(/[\r\n]/)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.on('error', finishReject)
    child.on('close', (code) => {
      if (pending) {
        consume('\n')
      }
      if (code === 0) {
        finishResolve(helpers)
      } else {
        finishReject(new Error(`ps exited with code ${code ?? 'unknown'}`))
      }
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

/** List a known helper and, when requested, stream the bounded orphan sweep. */
export async function listServeSimHelperProcessesForDevice(
  deviceUdid: string,
  options: ServeSimHelperProcessLookupOptions = {}
): Promise<ServeSimHelperProcess[]> {
  if (platform() !== 'darwin') {
    return []
  }
  const knownPid = options.helperPid
  const includeOrphaned = options.includeOrphaned === true
  if (knownPid === undefined && !includeOrphaned) {
    return []
  }
  const knownHelpers =
    knownPid === undefined
      ? []
      : parseServeSimHelperProcesses(
          await execFileText('ps', ['-p', String(knownPid), '-o', 'pid=,command='], {
            allowEmptySelection: true
          })
        ).filter((helper) => commandTargetsDevice(helper.command, deviceUdid))
  if (!includeOrphaned) {
    return knownHelpers
  }
  const orphanedHelpers = (await streamServeSimHelperProcesses()).filter((helper) =>
    commandTargetsDevice(helper.command, deviceUdid)
  )
  const helpersByPid = new Map<number, ServeSimHelperProcess>()
  for (const helper of [...knownHelpers, ...orphanedHelpers]) {
    helpersByPid.set(helper.pid, helper)
  }
  return [...helpersByPid.values()]
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
