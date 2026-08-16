import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  parseWorkerWatchdogRequest,
  parseWorkerWatchdogStartedReceipt,
  type WorkerWatchdogRequest,
  type WorkerWatchdogStartedReceipt
} from './worker-watchdog-protocol'

export type WatchedWorkerReceipt = WorkerWatchdogStartedReceipt

export type WorkerWatchdogLauncherDeps = {
  entryPath?: string
  execPath?: string
  moduleDir?: string
  resourcesPath?: string
  isPackaged?: boolean
  spawnImpl?: typeof spawn
  startupTimeoutMs?: number
}

export type PreparedWorkerWatchdogLaunch = {
  entryPath: string
  requestPath: string
}

export type WorkerWatchdogTerminalShell = 'posix' | 'fish' | 'cmd' | 'powershell'

export function resolveWorkerWatchdogEntryPath(
  deps: Pick<
    WorkerWatchdogLauncherDeps,
    'entryPath' | 'moduleDir' | 'resourcesPath' | 'isPackaged'
  > = {}
): string {
  if (deps.entryPath) {
    return deps.entryPath
  }
  if (deps.isPackaged) {
    if (!deps.resourcesPath) {
      throw new Error('Packaged worker watchdog requires process.resourcesPath.')
    }
    return join(deps.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'worker-watchdog-entry.js')
  }
  const moduleDir = deps.moduleDir ?? __dirname
  const candidates = [
    join(moduleDir, 'worker-watchdog-entry.js'),
    join(moduleDir, '..', 'worker-watchdog-entry.js')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function launchWatchedWorker(
  requestValue: WorkerWatchdogRequest,
  deps: WorkerWatchdogLauncherDeps = {}
): Promise<WatchedWorkerReceipt> {
  const request = parseWorkerWatchdogRequest(requestValue)
  const prepared = prepareWorkerWatchdogLaunch(request, deps)
  const execPath = deps.execPath ?? process.execPath
  const child = (deps.spawnImpl ?? spawn)(execPath, [prepared.entryPath, prepared.requestPath], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(execPath === process.execPath && process.versions.electron
        ? { ELECTRON_RUN_AS_NODE: '1' }
        : {})
    }
  })
  if (!child.pid || !child.stdout || !child.stderr) {
    child.kill()
    throw new Error('Worker watchdog process did not expose startup authority.')
  }
  child.unref()

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      fail(new Error('Worker watchdog did not acknowledge provider startup.'))
    }, deps.startupTimeoutMs ?? 15_000)

    const cleanup = () => {
      clearTimeout(timeout)
      child.stdout?.removeAllListeners()
      child.stderr?.removeAllListeners()
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    child.once('error', (error) => fail(error))
    child.once('exit', (code) => {
      fail(
        new Error(
          `Worker watchdog exited before startup acknowledgement (code ${code}): ${stderr.trim()}`
        )
      )
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) {
        stderr += String(chunk)
      }
    })
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const newline = stdout.indexOf('\n')
      if (newline === -1) {
        if (stdout.length > 16_384) {
          fail(new Error('Worker watchdog startup acknowledgement exceeded its size limit.'))
        }
        return
      }
      try {
        const receipt = parseWorkerWatchdogStartedReceipt(
          JSON.parse(stdout.slice(0, newline)) as unknown
        )
        if (
          receipt.dispatchId !== request.dispatchId ||
          receipt.sentinelPath !== request.sentinelPath ||
          receipt.watchdogPid !== child.pid
        ) {
          throw new Error('Worker watchdog startup authority did not match the request.')
        }
        settled = true
        cleanup()
        resolve(receipt)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

export function prepareWorkerWatchdogLaunch(
  requestValue: WorkerWatchdogRequest,
  deps: Pick<
    WorkerWatchdogLauncherDeps,
    'entryPath' | 'moduleDir' | 'resourcesPath' | 'isPackaged'
  > = {}
): PreparedWorkerWatchdogLaunch {
  const request = parseWorkerWatchdogRequest(requestValue)
  const entryPath = resolveWorkerWatchdogEntryPath(deps)
  if (!existsSync(entryPath)) {
    throw new Error(`Worker watchdog entry is unavailable at ${entryPath}.`)
  }
  mkdirSync(dirname(request.sentinelPath), { recursive: true, mode: 0o700 })
  const requestPath = join(
    dirname(request.sentinelPath),
    `.${request.dispatchId}-${randomBytes(8).toString('hex')}.request.json`
  )
  writeFileSync(requestPath, JSON.stringify(request), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  return { entryPath, requestPath }
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function buildWorkerWatchdogTerminalCommand(args: {
  execPath: string
  prepared: PreparedWorkerWatchdogLaunch
  shell: WorkerWatchdogTerminalShell
}): string {
  const values = [args.execPath, args.prepared.entryPath, args.prepared.requestPath]
  if (args.shell === 'posix' || args.shell === 'fish') {
    return `exec ${values.map(quotePosix).join(' ')}`
  }
  if (args.shell === 'powershell') {
    return `& ${values.map(quotePowerShell).join(' ')}`
  }
  return values.map((value) => `"${value}"`).join(' ')
}
