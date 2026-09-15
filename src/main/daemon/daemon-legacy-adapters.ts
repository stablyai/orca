import { readFileSync, unlinkSync } from 'node:fs'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { inspectProcessSignal } from './daemon-process-inspection'
import { parseDaemonPidFile, type ParsedDaemonPid } from './daemon-pid-file-parse'
import type { ProcessLivenessVerdict } from './daemon-incarnation-evidence-types'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

// Why: exported so the signal->verdict mapping is pinned directly; the reclaim gates below each
// independently preserve, so an "unlinked nothing" assertion cannot distinguish a correct
// 'unverifiable' from the pre-fix coercion of "cannot tell" into "dead".
export function legacyDaemonProcessLiveness(
  runtimeDir: string,
  protocolVersion: number
): { verdict: ProcessLivenessVerdict; provenRecordText: string | null } {
  let recordText: string
  try {
    recordText = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    return { verdict: { status: 'unverifiable', reason: String(error) }, provenRecordText: null }
  }
  const parsed: ParsedDaemonPid | null = parseDaemonPidFile(recordText)
  if (!parsed) {
    return {
      verdict: { status: 'unverifiable', reason: 'the daemon PID record could not be parsed' },
      provenRecordText: null
    }
  }
  // Why: the parser's legacy bare-integer fallback coerces an empty or whitespace-only record to
  // pid 0 (Number('') === 0) — the shape a concurrent read sees while a daemon publishes, since
  // writeFileSync 'wx' creates the record before writing it. process.kill(0, 0) probes the
  // caller's own process group rather than the daemon, so it answers 'occupied' and would publish
  // a false 'live'. That is the client's own bookkeeping, not host evidence: report unverifiable.
  if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    return {
      verdict: { status: 'unverifiable', reason: 'the daemon PID record does not name a process' },
      provenRecordText: null
    }
  }
  const evidence = inspectProcessSignal(parsed.pid)
  switch (evidence) {
    case 'occupied':
    case 'permission_denied':
      return { verdict: { status: 'live' }, provenRecordText: recordText }
    case 'missing':
      return { verdict: { status: 'exited' }, provenRecordText: recordText }
    case 'unavailable':
      return {
        verdict: { status: 'unverifiable', reason: 'the daemon process could not be queried' },
        provenRecordText: recordText
      }
  }
}

// Why: unlinking is the destructive direction and this is a statement position the compiler
// does not police for exhaustiveness — deletion must be opted into by a positively matched
// 'exited', so any future unhandled verdict status preserves ownership instead of deleting it.
export function reclaimLegacyDaemonOwnershipFiles(
  verdict: ProcessLivenessVerdict,
  provenRecordText: string | null,
  pidPath: string,
  tokenPath: string
): void {
  if (verdict.status !== 'exited' || provenRecordText === null) {
    return
  }
  // Cross-incarnation guard: 'exited' proves only that the RECORDED pid was
  // absent at probe time. An old build's own stale-kill can delete that record
  // and republish in the probe→unlink window, so delete only while the name
  // still holds the exact record proved dead; any other content (or a missing
  // record) means a new owner settled the name — preserve both files. A new
  // owner writes its token after publishing its record, so the record compare
  // shields the token too.
  let currentRecordText: string
  try {
    currentRecordText = readFileSync(pidPath, 'utf8')
  } catch {
    return
  }
  if (currentRecordText !== provenRecordText) {
    return
  }
  try {
    unlinkSync(pidPath)
  } catch {
    // Record not removable — leave the token with it rather than orphan it.
    return
  }
  try {
    unlinkSync(tokenPath)
  } catch {
    // Best-effort
  }
}

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeSocket(socketPath))) {
      // Why: a recycled stale pid later turns an identity check into a PowerShell spawn, so delete leaked pid/token files — but only when the pid-process is provably gone (a live daemon can transiently fail the probe, and dropping its token makes its sessions permanently unadoptable).
      const liveness = legacyDaemonProcessLiveness(runtimeDir, protocolVersion)
      reclaimLegacyDaemonOwnershipFiles(
        liveness.verdict,
        liveness.provenRecordText,
        getDaemonPidPath(runtimeDir, protocolVersion),
        getDaemonTokenPath(runtimeDir, protocolVersion)
      )
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
