import { readFileSync } from 'node:fs'
import { getDaemonPidPath } from './daemon-spawner'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import {
  getPsProcessIdentityAsync,
  queryWindowsProcessIdentity
} from './daemon-process-identity-query'
import {
  START_TIME_TOLERANCE_MS,
  startTimeMatches,
  startTimesWithinTolerance
} from './daemon-process-start-time'
import { PROTOCOL_VERSION } from './types'

// Why: on Windows the pid file's startedAtMs is the daemon's self-reported
// Node start time, while verification reads the OS process creation time —
// the gap between them is the exe bootstrap, which AV/disk pressure can
// stretch to seconds. Pid recycling differs by minutes-to-days, so a wide
// tolerance keeps the guard effective without false mismatches.
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

/**
 * 'unknown' is load-bearing: a failed inspection is not evidence that the recorded PID is
 * someone else's. `ps` runs under a 2s budget and PowerShell CIM under 3s, and a loaded
 * machine blows both — reading that as "not our daemon" is what authorized reclaiming a live
 * daemon's ownership in the first place.
 */
export type DaemonProcessIdentity = 'match' | 'mismatch' | 'unknown'

export async function inspectDaemonProcessIdentity(
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
