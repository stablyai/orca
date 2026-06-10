/* oxlint-disable max-lines -- Why: pid validation shares process-identity
helpers with kill escalation so the SIGKILL safety checks stay co-located. */
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { connect, type Socket } from 'net'
import { encodeNdjson } from './ndjson'
import { getDaemonPidPath } from './daemon-spawner'
import {
  PROTOCOL_VERSION,
  type HelloMessage,
  type HelloResponse,
  type SystemResolverHealth,
  type SystemResolverHealthResult
} from './types'

const HEALTH_CHECK_TIMEOUT_MS = 3_000
const RESOLVER_HEALTH_CHECK_TIMEOUT_MS = 3_000
const KILL_WAIT_MS = 3_000
const KILL_POLL_MS = 100
const START_TIME_TOLERANCE_MS = 1_500

export type DaemonHealthCheckResult = 'healthy' | 'unhealthy' | 'pty-spawn-unhealthy'

type ParsedDaemonPid = {
  pid: number
  startedAtMs: number | null
  entryPath: string | null
  appVersion: string | null
}

function canConnectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect({ path: socketPath })
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      sock.off('connect', onConnect)
      sock.off('error', onError)
    }
    const settle = (result: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    const onConnect = (): void => {
      settle(true)
      sock.destroy()
    }
    const onError = (): void => {
      settle(false)
    }
    const timer = setTimeout(() => {
      settle(false)
      sock.destroy()
    }, 500)
    sock.on('connect', onConnect)
    sock.on('error', onError)
  })
}

export function checkDaemonHealth(
  socketPath: string,
  tokenPath: string
): Promise<DaemonHealthCheckResult> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve('unhealthy')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve('unhealthy')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: DaemonHealthCheckResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      removeSocketListeners()
      sock?.destroy()
      resolve(result)
    }
    const removeSocketListeners = (): void => {
      sock?.off('error', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unhealthy')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        token,
        clientId: 'health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    }
    const onData = (chunk: Buffer): void => {
      if (settled) {
        return
      }
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }

        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          settle('unhealthy')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('unhealthy')
            return
          }
          sock?.write(encodeNdjson({ id: 'health-1', type: 'ping' }))
          continue
        }

        if (message.id === 'health-1') {
          if (!message.ok) {
            settle('unhealthy')
            return
          }
          // Why: protocol ping only proves the socket loop is alive. New
          // terminals also depend on node-pty's native helper state inside
          // the daemon process, which can go stale after dev rebuilds.
          sock?.write(encodeNdjson({ id: 'health-2', type: 'ptySpawnHealth' }))
          continue
        }

        if (message.id === 'health-2') {
          settle(message.ok ? 'healthy' : 'pty-spawn-unhealthy')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unhealthy'), HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}

export async function healthCheckDaemon(socketPath: string, tokenPath: string): Promise<boolean> {
  return (await checkDaemonHealth(socketPath, tokenPath)) === 'healthy'
}

function isSystemResolverHealth(value: unknown): value is SystemResolverHealth {
  return value === 'healthy' || value === 'unhealthy' || value === 'unknown'
}

export function getMacDaemonSystemResolverHealth(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<SystemResolverHealth> {
  if (process.platform !== 'darwin') {
    return Promise.resolve('unknown')
  }

  return new Promise((resolve) => {
    if (!existsSync(socketPath)) {
      resolve('unknown')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve('unknown')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: SystemResolverHealth): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      removeSocketListeners()
      sock?.destroy()
      resolve(result)
    }
    const removeSocketListeners = (): void => {
      sock?.off('error', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unknown')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: protocolVersion,
        token,
        clientId: 'resolver-health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    }
    const onData = (chunk: Buffer): void => {
      if (settled) {
        return
      }
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }

        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          settle('unknown')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('unknown')
            return
          }
          // Why: the daemon must report health from inside its own process;
          // external launchctl bsexec probes can misclassify healthy PTYs.
          sock?.write(encodeNdjson({ id: 'resolver-health-1', type: 'systemResolverHealth' }))
          continue
        }

        if (message.id === 'resolver-health-1') {
          if (!message.ok || typeof message.payload !== 'object' || message.payload === null) {
            settle('unknown')
            return
          }
          const payload = message.payload as Partial<SystemResolverHealthResult>
          settle(isSystemResolverHealth(payload.health) ? payload.health : 'unknown')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unknown'), RESOLVER_HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}

function commandLineMatchesDaemon(
  commandLine: string,
  socketPath: string,
  tokenPath: string
): boolean {
  return (
    commandLine.includes('daemon-entry') &&
    commandLine.includes(socketPath) &&
    commandLine.includes(tokenPath)
  )
}

export function parseDaemonPidFile(contents: string): ParsedDaemonPid | null {
  const trimmed = contents.trim()
  try {
    const parsed = JSON.parse(trimmed) as {
      pid?: unknown
      startedAtMs?: unknown
      entryPath?: unknown
      appVersion?: unknown
    }
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
            ? parsed.startedAtMs
            : null,
        entryPath: typeof parsed.entryPath === 'string' ? parsed.entryPath : null,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null
      }
    }
  } catch {
    // Legacy daemons wrote the pid file as a bare integer.
  }

  const pid = Number(trimmed)
  return Number.isFinite(pid) ? { pid, startedAtMs: null, entryPath: null, appVersion: null } : null
}

function getLinuxProcessStartedAtMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const afterCommand = stat.slice(stat.lastIndexOf(')') + 2)
    const fields = afterCommand.split(' ')
    const startTicks = Number(fields[19])
    const bootTimeLine = readFileSync('/proc/stat', 'utf8')
      .split('\n')
      .find((line) => line.startsWith('btime '))
    const bootTimeSeconds = bootTimeLine ? Number(bootTimeLine.split(/\s+/)[1]) : Number.NaN
    const ticksPerSecond = Number(
      execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1_000 }).trim()
    )
    if (
      !Number.isFinite(startTicks) ||
      !Number.isFinite(bootTimeSeconds) ||
      !Number.isFinite(ticksPerSecond) ||
      ticksPerSecond <= 0
    ) {
      return null
    }
    return bootTimeSeconds * 1000 + (startTicks / ticksPerSecond) * 1000
  } catch {
    return null
  }
}

export function getProcessStartedAtMs(pid: number): number | null {
  if (process.platform === 'linux') {
    return getLinuxProcessStartedAtMs(pid)
  }

  if (process.platform === 'win32') {
    return null
  }

  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2_000
    }).trim()
    const startedAtMs = Date.parse(output)
    return Number.isFinite(startedAtMs) ? startedAtMs : null
  } catch {
    return null
  }
}

export function startTimeMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  if (expectedStartedAtMs === null) {
    return true
  }

  const actualStartedAtMs = getProcessStartedAtMs(pid)
  if (actualStartedAtMs === null) {
    return true
  }

  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= START_TIME_TOLERANCE_MS
}

function isDaemonProcess(
  pid: number,
  socketPath: string,
  tokenPath: string,
  startedAtMs: number | null
): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
        ],
        {
          encoding: 'utf8',
          timeout: 3_000
        }
      )
      // Why: image names are too broad after PID reuse. Match the daemon entry
      // plus the exact socket/token args so we only kill the daemon for this
      // userData protocol endpoint.
      return (
        commandLineMatchesDaemon(output, socketPath, tokenPath) &&
        startTimeMatches(pid, startedAtMs)
      )
    } catch {
      return false
    }
  }

  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return (
      commandLineMatchesDaemon(cmdline, socketPath, tokenPath) && startTimeMatches(pid, startedAtMs)
    )
  } catch {
    try {
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2_000
      })
      return (
        commandLineMatchesDaemon(output, socketPath, tokenPath) &&
        startTimeMatches(pid, startedAtMs)
      )
    } catch {
      return false
    }
  }
}

function getDaemonCommandLine(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      return execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
        ],
        {
          encoding: 'utf8',
          timeout: 3_000
        }
      )
    } catch {
      return null
    }
  }

  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2_000
      })
    } catch {
      return null
    }
  }
}

export type DaemonLaunchIdentity = 'match' | 'mismatch' | 'unknown'

export function getDaemonLaunchIdentity(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  expectedEntryPath: string,
  protocolVersion = PROTOCOL_VERSION
): DaemonLaunchIdentity {
  const parsedPid = readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath, protocolVersion)
  if (!parsedPid) {
    return 'unknown'
  }

  if (parsedPid.entryPath) {
    return parsedPid.entryPath === expectedEntryPath ? 'match' : 'mismatch'
  }

  // Why: older pid files did not persist entryPath. The command line still
  // carries daemon-entry.js, so use it to stop dev worktrees from reusing a
  // daemon forked from a deleted sibling checkout. If command-line probing is
  // unavailable, fail open so we don't kill live sessions unnecessarily.
  const commandLine = getDaemonCommandLine(parsedPid.pid)
  if (!commandLine) {
    return 'unknown'
  }
  return commandLine.includes(expectedEntryPath) ? 'match' : 'mismatch'
}

function readVerifiedDaemonPid(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): ParsedDaemonPid | null {
  let parsedPid: ParsedDaemonPid | null
  try {
    parsedPid = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
  } catch {
    return null
  }

  if (!parsedPid || !isDaemonProcess(parsedPid.pid, socketPath, tokenPath, parsedPid.startedAtMs)) {
    return null
  }

  return parsedPid
}

export function isDaemonStaleForCurrentBundle(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  currentAppVersion: string,
  protocolVersion = PROTOCOL_VERSION
): boolean {
  const parsedPid = readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath, protocolVersion)
  if (!parsedPid) {
    return false
  }

  if (parsedPid.appVersion !== null) {
    return parsedPid.appVersion !== currentAppVersion
  }

  // Why: older packaged daemons do not carry a reliable build-generation
  // marker. Replacing them once prevents archive-preserved mtimes from
  // reusing stale native modules across the first metadata-aware upgrade.
  return true
}

export async function killStaleDaemon(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<boolean> {
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  let killedDaemon = false
  try {
    const parsedPid = parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
    if (parsedPid && isDaemonProcess(parsedPid.pid, socketPath, tokenPath, parsedPid.startedAtMs)) {
      const { pid, startedAtMs } = parsedPid
      process.kill(pid, 'SIGTERM')
      const deadline = Date.now() + KILL_WAIT_MS
      let exited = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
      }
      if (!exited) {
        // Why: re-check process identity before SIGKILL. The SIGTERM-then-wait
        // window is long enough for the pid to be recycled if the original
        // daemon died during the wait. Without this, we'd SIGKILL an unrelated
        // process that happens to now own the same pid.
        if (!isDaemonProcess(pid, socketPath, tokenPath, startedAtMs)) {
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
          exited = true
          killedDaemon = true
        } else {
          try {
            process.kill(pid, 'SIGKILL')
            exited = true
          } catch {
            // Already dead
          }
        }
      }
      killedDaemon = killedDaemon || exited
    }
  } catch {
    // PID file missing or process already dead
  }

  try {
    unlinkSync(pidPath)
  } catch {
    // Best-effort
  }

  const socketIsLive = await canConnectSocket(socketPath)
  if (process.platform !== 'win32' && existsSync(socketPath) && (killedDaemon || !socketIsLive)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // Best-effort
    }
  }
  return killedDaemon
}
