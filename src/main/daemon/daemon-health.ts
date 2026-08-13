/* oxlint-disable max-lines -- Why: pid validation shares process-identity
helpers with kill escalation so the SIGKILL safety checks stay co-located. */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { promisify } from 'node:util'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'
import { encodeNdjson } from './ndjson'
import {
  getDaemonPidPath,
  unlinkDaemonPidFileWhen,
  unlinkOwnedDaemonPidFile
} from './daemon-spawner'
import {
  endpointIsProvenDead,
  probeSocketConnect,
  type SocketProbeOutcome
} from './daemon-endpoint-probe'
import {
  PROTOCOL_VERSION,
  type HelloMessage,
  type HelloResponse,
  type SystemResolverHealth,
  type SystemResolverHealthResult
} from './types'

export const HEALTH_CHECK_TIMEOUT_MS = 3_000
/** Ceiling on one identity `ps`; the launch budget reserves against it, so it is exported rather than inline. */
export const PS_IDENTITY_TIMEOUT_MS = 2_000
const RESOLVER_HEALTH_CHECK_TIMEOUT_MS = 3_000
const KILL_WAIT_MS = 3_000
const KILL_POLL_MS = 100
// Why: SIGKILL is delivered on return from an uninterruptible syscall, so confirm the exit
// rather than assume it — but keep the wait short, it only guards the rare wedged case.
const SIGKILL_CONFIRM_WAIT_MS = 1_000
const START_TIME_TOLERANCE_MS = 1_500
// Why: e2e forces the failed-health preserve path without SIGSTOP races —
// a stopped daemon also blocks listSessions, so the unhealthy guard cannot
// verify live sessions until SIGCONT, which is flaky under CI load.
export const E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV = 'ORCA_E2E_FORCE_DAEMON_HEALTH_UNREACHABLE'
// Why: on Windows the pid file's startedAtMs is the daemon's self-reported
// Node start time, while verification reads the OS process creation time —
// the gap between them is the exe bootstrap, which AV/disk pressure can
// stretch to seconds. Pid recycling differs by minutes-to-days, so a wide
// tolerance keeps the guard effective without false mismatches.
const WIN32_START_TIME_TOLERANCE_MS = 10_000

// 'rejected' means the daemon answered and refused the handshake (bad token,
// foreign protocol) — it can never be adopted, unlike 'unreachable', which
// also covers a live-but-wedged daemon that simply missed the RPC budget.
export type DaemonHealth = 'healthy' | 'unreachable' | 'rejected' | 'pty-spawn-unhealthy'

export type ParsedDaemonPid = {
  pid: number
  startedAtMs: number | null
  entryPath: string | null
  appVersion: string | null
  launchNonce: string | null
  linuxStartTicks: string | null
  bootId: string | null
  spawnerExecPath: string | null
}

export function checkDaemonHealth(socketPath: string, tokenPath: string): Promise<DaemonHealth> {
  return new Promise((resolve) => {
    if (process.env[E2E_FORCE_DAEMON_HEALTH_UNREACHABLE_ENV] === '1') {
      resolve('unreachable')
      return
    }

    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve('unreachable')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve('unreachable')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: DaemonHealth): void => {
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
    const onError = (): void => settle('unreachable')
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
          settle('rejected')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('rejected')
            return
          }
          // Why: a protocol-live daemon with a stale cwd or node-pty helper
          // will answer ping but cannot create terminals, so reuse must check
          // the PTY spawn prerequisites too.
          sock?.write(encodeNdjson({ id: 'health-1', type: 'ptySpawnHealth' }))
          continue
        }

        if (message.id === 'health-1') {
          settle(message.ok === true ? 'healthy' : 'pty-spawn-unhealthy')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unreachable'), HEALTH_CHECK_TIMEOUT_MS)

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
          sock?.write(
            encodeNdjson({
              id: 'resolver-health-1',
              type: 'systemResolverHealth'
            })
          )
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

export function commandLineMatchesDaemon(
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
      launchNonce?: unknown
      linuxStartTicks?: unknown
      bootId?: unknown
      spawnerExecPath?: unknown
    }
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
            ? parsed.startedAtMs
            : null,
        entryPath: typeof parsed.entryPath === 'string' ? parsed.entryPath : null,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null,
        launchNonce: typeof parsed.launchNonce === 'string' ? parsed.launchNonce : null,
        linuxStartTicks: typeof parsed.linuxStartTicks === 'string' ? parsed.linuxStartTicks : null,
        bootId: typeof parsed.bootId === 'string' ? parsed.bootId : null,
        spawnerExecPath: typeof parsed.spawnerExecPath === 'string' ? parsed.spawnerExecPath : null
      }
    }
  } catch {
    // Legacy daemons wrote the pid file as a bare integer.
  }

  const pid = Number(trimmed)
  return Number.isFinite(pid)
    ? {
        pid,
        startedAtMs: null,
        entryPath: null,
        appVersion: null,
        launchNonce: null,
        linuxStartTicks: null,
        bootId: null,
        spawnerExecPath: null
      }
    : null
}

function getLinuxProcessStartedAtMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const startTicks = parseLinuxProcStartTicks(stat)
    const bootTimeSeconds = parseLinuxBootTimeSeconds(readFileSync('/proc/stat', 'utf8'))
    const ticksPerSecond = Number(
      execFileSync('getconf', ['CLK_TCK'], {
        encoding: 'utf8',
        timeout: 1_000
      }).trim()
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

export function parseLinuxProcStartTicks(stat: string): number {
  const commandEndIndex = stat.lastIndexOf(')')
  if (commandEndIndex === -1) {
    return Number.NaN
  }

  const fields = getProcessOutputFields(stat.slice(commandEndIndex + 1), 20)
  return Number(fields[19])
}

export function parseLinuxBootTimeSeconds(procStat: string): number {
  for (const line of iterateProcessOutputLines(procStat)) {
    if (!line.startsWith('btime ')) {
      continue
    }
    return Number(getProcessOutputFields(line, 2)[1])
  }
  return Number.NaN
}

export function getProcessStartedAtMs(pid: number): number | null {
  if (process.platform === 'linux') {
    return getLinuxProcessStartedAtMs(pid)
  }

  if (process.platform === 'win32') {
    // Why: the only OS source is a CIM query costing a powershell spawn —
    // too slow for this sync path. Windows pid files instead carry the
    // daemon's self-reported start time from its ready message, and
    // isDaemonProcess verifies it against CIM CreationDate asynchronously.
    return null
  }

  return getPsProcessIdentity(pid)?.startedAtMs ?? null
}

export function startTimeMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  return startTimesWithinTolerance(
    getProcessStartedAtMs(pid),
    expectedStartedAtMs,
    START_TIME_TOLERANCE_MS
  )
}

// Why: fail open on null — a pid file or OS query without a start time must
// not veto an otherwise-matching daemon (adoption safety beats recycle safety).
export function startTimesWithinTolerance(
  actualStartedAtMs: number | null,
  expectedStartedAtMs: number | null,
  toleranceMs: number
): boolean {
  if (expectedStartedAtMs === null || actualStartedAtMs === null) {
    return true
  }
  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= toleranceMs
}

const execFileAsync = promisify(execFile)

export type WindowsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

type PsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

function getPsProcessIdentity(pid: number): PsProcessIdentity | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      timeout: PS_IDENTITY_TIMEOUT_MS
    })
    // BSD ps formats lstart as a fixed-width 24-character timestamp.
    const startedAtMs = Date.parse(output.slice(0, 24))
    const commandLine = output.slice(24).trim()
    return {
      commandLine,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
    }
  } catch {
    return null
  }
}

export function parseWindowsProcessIdentityJson(stdout: string): WindowsProcessIdentity | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as { cmd?: unknown; start?: unknown }
    if (typeof parsed.cmd !== 'string' || !parsed.cmd) {
      return null
    }
    return {
      commandLine: parsed.cmd,
      startedAtMs:
        typeof parsed.start === 'number' && Number.isFinite(parsed.start) ? parsed.start : null
    }
  } catch {
    return null
  }
}

// Why: the only reliable command-line source on Windows is a CIM query, which
// costs a full powershell.exe spawn (300-800ms cold, worse under Defender).
// Async because the sync version measurably froze the Electron main thread at
// startup for the whole spawn (benchmark: ~0.5s warm, 3s timeout cap cold).
// CreationDate rides along in the same spawn so start-time verification adds
// zero extra process launches. Timed under ORCA_STARTUP_DIAGNOSTICS so the
// cold-start benchmark can attribute startup cost to these checks.
async function queryWindowsProcessIdentity(pid: number): Promise<WindowsProcessIdentity | null> {
  const startedAt = performance.now()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          `if ($p) { $start = $null; ` +
          `if ($p.CreationDate) { $start = [long]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }; ` +
          `@{ cmd = $p.CommandLine; start = $start } | ConvertTo-Json -Compress }`
      ],
      {
        encoding: 'utf8',
        timeout: 3_000
      }
    )
    return parseWindowsProcessIdentityJson(stdout)
  } catch {
    return null
  } finally {
    if (isStartupDiagnosticsEnabled()) {
      logStartupDiagnostic('daemon-pid-check', {
        t: Math.round(performance.now()),
        pid,
        ms: Math.round(performance.now() - startedAt)
      })
    }
  }
}

/**
 * 'unknown' is load-bearing: a failed inspection is not evidence that the recorded PID is
 * someone else's. `ps` runs under a 2s budget and PowerShell CIM under 3s, and a loaded
 * machine blows both — reading that as "not our daemon" is what authorized reclaiming a live
 * daemon's ownership in the first place.
 */
type DaemonProcessIdentity = 'match' | 'mismatch' | 'unknown'

async function inspectDaemonProcessIdentity(
  pid: number,
  socketPath: string,
  tokenPath: string,
  startedAtMs: number | null
): Promise<DaemonProcessIdentity> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // Why: only ESRCH proves the process is gone. EPERM means it exists and belongs to
    // another user — reading that as absence deletes a live daemon's ownership.
    return isNoSuchProcessError(error) ? 'mismatch' : 'unknown'
  }

  const verdict = (matches: boolean): DaemonProcessIdentity => (matches ? 'match' : 'mismatch')

  if (process.platform === 'win32') {
    const identity = await queryWindowsProcessIdentity(pid)
    if (identity === null) {
      return 'unknown'
    }
    // Why: image names are too broad after PID reuse. Match the daemon entry
    // plus the exact socket/token args so we only kill the daemon for this
    // userData protocol endpoint.
    return verdict(
      commandLineMatchesDaemon(identity.commandLine, socketPath, tokenPath) &&
        startTimesWithinTolerance(identity.startedAtMs, startedAtMs, WIN32_START_TIME_TOLERANCE_MS)
    )
  }

  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return verdict(
      commandLineMatchesDaemon(cmdline, socketPath, tokenPath) && startTimeMatches(pid, startedAtMs)
    )
  } catch {
    const identity = getPsProcessIdentity(pid)
    if (!identity) {
      return 'unknown'
    }
    return verdict(
      commandLineMatchesDaemon(identity.commandLine, socketPath, tokenPath) &&
        startTimesWithinTolerance(identity.startedAtMs, startedAtMs, START_TIME_TOLERANCE_MS)
    )
  }
}

async function getDaemonCommandLine(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    return (await queryWindowsProcessIdentity(pid))?.commandLine ?? null
  }

  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return getPsProcessIdentity(pid)?.commandLine ?? null
  }
}

export type DaemonLaunchIdentity = 'match' | 'mismatch' | 'unknown'

export async function getDaemonLaunchIdentity(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  expectedEntryPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<DaemonLaunchIdentity> {
  const parsedPid = await readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath, protocolVersion)
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
  const commandLine = await getDaemonCommandLine(parsedPid.pid)
  if (!commandLine) {
    return 'unknown'
  }
  return commandLine.includes(expectedEntryPath) ? 'match' : 'mismatch'
}

export async function readVerifiedDaemonPid(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<ParsedDaemonPid | null> {
  let parsedPid: ParsedDaemonPid | null
  try {
    parsedPid = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
  } catch {
    return null
  }

  if (
    !parsedPid ||
    (await inspectDaemonProcessIdentity(
      parsedPid.pid,
      socketPath,
      tokenPath,
      parsedPid.startedAtMs
    )) !== 'match'
  ) {
    return null
  }

  return parsedPid
}

export async function isDaemonStaleForCurrentBundle(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  currentAppVersion: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<boolean> {
  const parsedPid = await readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath, protocolVersion)
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

// 'severed': macOS can no longer resolve the daemon's TCC responsible process, so
// Accessibility/Automation grants on Orca silently stop covering its terminals (STA-3491).
// 'unknown' fails open: legacy pid files and probe failures must not trigger replacement.
export type MacDaemonTccAttributionHealth = 'intact' | 'severed' | 'unknown'

/**
 * macOS pins a process's TCC "responsible process" to the binary that forked it,
 * by file reference. The detached daemon outlives that app instance, and once the
 * spawning binary is deleted (every packaged update replaces the bundle) tccd
 * can't resolve the grant subject — `osascript`/System Events from every terminal
 * hosted by that daemon is silently denied (-25211) no matter what the user grants.
 */
export async function getMacDaemonTccAttributionHealth(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  packagedAppVersion: string | null,
  protocolVersion = PROTOCOL_VERSION
): Promise<MacDaemonTccAttributionHealth> {
  if (process.platform !== 'darwin') {
    return 'unknown'
  }
  const parsedPid = await readVerifiedDaemonPid(runtimeDir, socketPath, tokenPath, protocolVersion)
  if (!parsedPid) {
    return 'unknown'
  }
  // Packaged updates can replace the bundle at the same path, so path existence
  // alone cannot prove the recorded spawning binary still backs this daemon.
  if (
    packagedAppVersion !== null &&
    parsedPid.appVersion !== null &&
    parsedPid.appVersion !== packagedAppVersion
  ) {
    return 'severed'
  }
  if (parsedPid.spawnerExecPath) {
    return existsSync(parsedPid.spawnerExecPath) ? 'intact' : 'severed'
  }
  return 'unknown'
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
  }
}

/**
 * Direct-construction-only seam. Which errno a non-socket path yields is platform-specific
 * (macOS ENOTSOCK vs Linux refused), so the decision rule below cannot be driven portably
 * through real syscalls. The probe itself is covered separately; this injects its verdict.
 */
export type StaleDaemonKillTestHooks = {
  probeEndpoint?: (socketPath: string) => Promise<SocketProbeOutcome>
}

export type StaleDaemonKillOutcome = {
  /** A daemon was positively confirmed gone. Drives replacement telemetry. */
  killed: boolean
  /**
   * We could not prove the recorded daemon is gone. Its PID record and endpoint are left
   * intact and the caller must not fork a replacement beside it — that is exactly how two
   * daemons end up alive with one owning the socket and the other hosting the sessions.
   */
  liveOwnerSurvived: boolean
}

export async function killStaleDaemon(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION,
  testHooks?: StaleDaemonKillTestHooks
): Promise<StaleDaemonKillOutcome> {
  const probeEndpoint = testHooks?.probeEndpoint ?? probeSocketConnect
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)
  let killedDaemon = false
  let liveOwnerSurvived = false
  // Why: identity is resolved once, and the record we may later remove is captured here so
  // cleanup can be fenced to this exact incarnation rather than to whatever occupies the path
  // by the time we get there.
  let recordedOwner: ParsedDaemonPid | null = null
  try {
    const parsedPid = parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
    recordedOwner = parsedPid
    const identity = parsedPid
      ? await inspectDaemonProcessIdentity(
          parsedPid.pid,
          socketPath,
          tokenPath,
          parsedPid.startedAtMs
        )
      : 'mismatch'
    if (
      parsedPid &&
      identity === 'unknown' &&
      !endpointIsProvenDead(await probeEndpoint(socketPath))
    ) {
      // Why: the inspection failed, which is not evidence that this PID is someone else's.
      // The endpoint is the tiebreaker, and it only settles the question when it positively
      // proves nothing is serving. A probe that merely timed out is not proof either, so
      // two inconclusive signals must preserve ownership rather than combine into a licence.
      console.warn(
        '[daemon] Preserving daemon that could not be inspected: reason=identity_probe_failed'
      )
      return { killed: false, liveOwnerSurvived: true }
    }
    if (parsedPid && identity === 'match') {
      const { pid, startedAtMs } = parsedPid
      try {
        process.kill(pid, 'SIGTERM')
      } catch (error) {
        // Why: ESRCH means it is already gone. Anything else (EPERM from a daemon owned by
        // another user) means it is alive and we cannot stop it — falling through to the
        // blanket catch would report "nothing alive" and authorize a duplicate beside it.
        if (!isNoSuchProcessError(error)) {
          return { killed: false, liveOwnerSurvived: true }
        }
      }
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
        const recheck = await inspectDaemonProcessIdentity(pid, socketPath, tokenPath, startedAtMs)
        if (recheck === 'mismatch') {
          // Why: the pid provably no longer belongs to our daemon, so it is gone regardless
          // of what the endpoint says.
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
          exited = true
        } else if (recheck === 'unknown') {
          // Why: the inspection failed under load. Only an endpoint that proves nothing is
          // serving may license reclaiming — a timed-out probe is not a second opinion.
          if (endpointIsProvenDead(await probeEndpoint(socketPath))) {
            console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
            exited = true
          } else {
            console.warn(
              '[daemon] Preserving daemon that could not be identified: reason=identity_probe_failed'
            )
            liveOwnerSurvived = true
          }
        } else {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already dead
            exited = true
          }
          // Why: issuing SIGKILL is not proof of death — a process blocked in an
          // uninterruptible syscall only dies once it returns. Claiming the kill without
          // confirming it is what let the endpoint be reclaimed out from under a daemon
          // that was still alive and still serving.
          exited = exited || (await waitForProcessExit(pid, SIGKILL_CONFIRM_WAIT_MS))
          if (!exited) {
            console.warn('[daemon] Daemon survived SIGKILL: reason=unconfirmed_exit')
          }
        }
      }
      killedDaemon = exited
      // Why: SIGTERM and SIGKILL both failed to produce an exit, so the daemon is still out
      // there holding the endpoint. Treat it as the owner rather than racing it.
      liveOwnerSurvived = liveOwnerSurvived || !exited
    }
  } catch {
    // PID file missing or process already dead
  }

  if (liveOwnerSurvived) {
    // Why: removing the record of a daemon we failed to kill is what let a replacement
    // publish its own ownership beside it. Leaving it intact keeps the exclusive PID claim
    // held, so a duplicate cannot take the endpoint.
    return { killed: killedDaemon, liveOwnerSurvived }
  }

  // Why: remove only the record belonging to the daemon we just dealt with. An unfenced
  // unlink deletes whatever occupies the path now, which after a slow kill can be a
  // replacement's freshly published ownership.
  if (recordedOwner) {
    unlinkOwnedDaemonPidFile(pidPath, recordedOwner.pid, recordedOwner.launchNonce)
  } else {
    // Why: a record we cannot parse names no owner to fence against, but leaving it in place
    // fails the next daemon's exclusive publish with EEXIST — no daemon at all. Reclaim it
    // under the same rename claim, and only while it is still unparseable, so a valid record
    // published in the meantime is left alone.
    unlinkDaemonPidFileWhen(pidPath, (content) => parseDaemonPidFile(content) === null)
  }

  // Why this only reads: removing an endpoint on another daemon's behalf is the whole defect
  // class this design retires. A replacement takes the name itself, by replacing an entry it
  // has proven dead in one rename. So the only question left here is whether something is
  // still answering — and only a positive answer withholds the fork.
  // An unclassifiable entry is no longer a reason to refuse: the publisher probes again and
  // will not overwrite anything it cannot prove dead, which makes this judgement a hint
  // rather than a correctness dependency.
  if ((await probeEndpoint(socketPath)) === 'connected') {
    return { killed: killedDaemon, liveOwnerSurvived: true }
  }
  return { killed: killedDaemon, liveOwnerSurvived }
}
