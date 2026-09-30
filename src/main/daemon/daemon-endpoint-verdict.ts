import { readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { isDaemonGoneError } from './daemon-endpoint-errors'
import { probeSocketConnect } from './daemon-endpoint-probe'
import {
  DaemonProtocolError,
  isDaemonEndpointConnectRejection,
  TerminalHostGoneError,
  TerminalSessionOwnerUnverifiedError
} from './daemon-errors'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { inspectProcessLiveness } from './daemon-process-inspection'

/** Named so a caller clamping this probe to a deadline cannot silently decouple from its default. */
export const DAEMON_ENDPOINT_PROBE_TIMEOUT_MS = 1_000

// Why generous: the record's start and this boot's start are both wall-clock, which a step shifts.
const BOOT_TIME_TOLERANCE_MS = 5 * 60_000

/**
 * The app's one answer to "is a daemon serving this endpoint?". A connect proves `live`. Only a
 * missing endpoint, or a refusal while the recorded daemon process is gone, proves `exited`:
 * macOS refuses a live listener once its accept queue is full, and a probe that lost to its timer
 * (a stalled main thread at boot) proves nothing (docs/reference/ssh-execution-boundary.md).
 */
export async function probeDaemonEndpoint(
  socketPath: string,
  pidPath: string | null,
  timeoutMs = DAEMON_ENDPOINT_PROBE_TIMEOUT_MS
): Promise<ProcessLivenessVerdict> {
  switch (await probeSocketConnect(socketPath, timeoutMs)) {
    case 'connected':
      return { status: 'live' }
    case 'missing':
      return { status: 'exited' }
    case 'refused':
      return recordedDaemonVerdict(pidPath)
    case 'unknown':
      return { status: 'unverifiable', reason: 'the endpoint did not answer' }
  }
}

export type DaemonEndpointRecord = { socketPath: string; pidPath: string | null }

/** Re-derived on every failure, never stored, so a version that exits mid-run reads as empty. */
export async function connectFailureProvesExit(
  error: unknown,
  endpoint: DaemonEndpointRecord
): Promise<boolean> {
  return (
    isDaemonEndpointConnectRejection(error) &&
    (await probeDaemonEndpoint(endpoint.socketPath, endpoint.pidPath)).status === 'exited'
  )
}

/**
 * Only the owner answering "absent", or a proven exit, may end a pane's saved session. A failure
 * that never heard the owner leaves it unverified, which keeps the binding and offers Retry.
 */
export async function attachOnlyFailure(
  error: unknown,
  sessionId: string,
  endpoint: DaemonEndpointRecord
): Promise<unknown> {
  if (isDaemonEndpointConnectRejection(error)) {
    return (await connectFailureProvesExit(error, endpoint))
      ? new TerminalHostGoneError()
      : new TerminalSessionOwnerUnverifiedError(sessionId)
  }
  return isContactFailure(error) ? new TerminalSessionOwnerUnverifiedError(sessionId) : error
}

function isContactFailure(error: unknown): boolean {
  return (
    error instanceof DaemonProtocolError ||
    isDaemonGoneError(error) ||
    (typeof error === 'object' &&
      error !== null &&
      'syscall' in error &&
      error.syscall === 'connect')
  )
}

function recordedDaemonVerdict(pidPath: string | null): ProcessLivenessVerdict {
  if (!pidPath) {
    return { status: 'unverifiable', reason: 'the endpoint refused and no pid record is known' }
  }
  let contents: string
  try {
    contents = readFileSync(pidPath, 'utf8')
  } catch (error) {
    // Why: the daemon deletes it on exit; older app builds also did so after a mere timeout.
    return hasErrorCode(error, 'ENOENT')
      ? { status: 'exited' }
      : { status: 'unverifiable', reason: 'the endpoint refused and its pid record is unreadable' }
  }
  const record = parseDaemonPidFile(contents)
  // Why: an empty record parses to pid 0, and process.kill(0, 0) probes our own process group.
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
    return { status: 'unverifiable', reason: 'the endpoint refused and its pid record is invalid' }
  }
  const liveness = inspectProcessLiveness(record.pid)
  if (liveness.status === 'live' && startedBeforeThisBoot(record.startedAtMs)) {
    // Why: whatever answers to that pid now, it is not a process recorded before the last boot.
    return { status: 'exited' }
  }
  return liveness.status === 'live'
    ? { status: 'unverifiable', reason: 'the endpoint refused while its daemon process runs' }
    : liveness
}

function startedBeforeThisBoot(startedAtMs: number | null): boolean {
  return startedAtMs !== null && startedAtMs < Date.now() - uptime() * 1000 - BOOT_TIME_TOLERANCE_MS
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
