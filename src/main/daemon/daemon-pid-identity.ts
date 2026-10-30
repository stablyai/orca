import { readFileSync } from 'node:fs'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import { getPsProcessIdentityAsync, type ProcessIdentity } from './daemon-process-identity-query'
import { queryWindowsProcess } from './daemon-process-inspection'
import {
  START_TIME_TOLERANCE_MS,
  startTimeMatches,
  startTimesWithinTolerance
} from './daemon-process-start-time'
import { PROTOCOL_VERSION } from './types'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'

// Windows OS creation precedes Node self-report; allow bootstrap delays from antivirus or disk pressure.
const WIN32_START_TIME_TOLERANCE_MS = 10_000

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

export function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

/** Inspection failures are unknown, never proof that a live daemon lost ownership. */
export type DaemonProcessIdentity = 'match' | 'mismatch' | 'unknown'

async function queryWindowsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const startedAt = performance.now()
  try {
    const evidence = await queryWindowsProcess(pid)
    // A signal-live PID with an absent or denied table row has unknown identity.
    return evidence.status === 'present' && evidence.commandLine
      ? { commandLine: evidence.commandLine, startedAtMs: evidence.startedAtMs }
      : null
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

export async function inspectDaemonProcessIdentity(
  pid: number,
  socketPath: string,
  tokenPath: string,
  startedAtMs: number | null
): Promise<DaemonProcessIdentity> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    // Only ESRCH proves absence; EPERM must not authorize ownership cleanup.
    return isNoSuchProcessError(error) ? 'mismatch' : 'unknown'
  }

  const verdict = (matches: boolean): DaemonProcessIdentity => (matches ? 'match' : 'mismatch')

  if (process.platform === 'win32') {
    const identity = await queryWindowsProcessIdentity(pid)
    if (identity === null) {
      return 'unknown'
    }
    // Image names alone cannot distinguish a recycled PID from this protocol endpoint.
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
    const identity = await getPsProcessIdentityAsync(pid)
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
    return (await getPsProcessIdentityAsync(pid))?.commandLine ?? null
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

  // Older records lack entryPath; use argv to avoid adopting a daemon from a deleted sibling checkout.
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
