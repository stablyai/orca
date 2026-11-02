/**
 * What `orca terminal-daemon status` reports about the daemon this server uses. The daemon is
 * respawned lazily, so between a crash and the next terminal there is none; that window must read
 * as `exited`, not as healthy. Vocabulary per the SSH execution boundary: live / unverifiable /
 * exited, and only positive proof earns `exited`.
 */
import { parseLinuxStartTicks } from '../agent-hooks/managed-hook-owner-identity'
import { checkDaemonHealthWithCoverage, type DaemonHealthCheck } from './daemon-health'
import { inspectProcessLiveness, readLinuxStat } from './daemon-process-inspection'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import { getDaemonEndpointFacts, readDaemonPidRecord } from './daemon-provider-state'
import {
  confirmPtyProcessCeiling,
  type PtyProcessCeilingState
} from '../../shared/pty-process-ceiling-state'

export type TerminalDaemonLivenessReport = {
  verdict: 'live' | 'unverifiable' | 'exited'
  pid: number | null
  detail: string
  /** Only for a live daemon: a dead one's record says nothing about the next one. */
  processCeiling: PtyProcessCeilingState | null
}

export type DaemonLivenessDependencies = {
  endpoint: () => { socketPath: string; tokenPath: string } | null
  checkHealth: (socketPath: string, tokenPath: string) => Promise<DaemonHealthCheck>
  readRecord: () => ParsedDaemonPid | null
  inspectPid: (record: ParsedDaemonPid) => Promise<'live' | 'exited' | 'unverifiable'>
  confirmCeiling: (state: PtyProcessCeilingState | null) => PtyProcessCeilingState | null
}

const LIVE_DETAIL: Record<DaemonHealthCheck['verdict'], string> = {
  healthy: 'it answered its health check',
  'pty-spawn-unhealthy': 'it answered, but could not start a test terminal',
  rejected: "it answered, but refused this server's handshake",
  unreachable: ''
}

export async function readTerminalDaemonLiveness(
  deps: DaemonLivenessDependencies = defaultDependencies
): Promise<TerminalDaemonLivenessReport> {
  const endpoint = deps.endpoint()
  if (!endpoint) {
    return {
      verdict: 'unverifiable',
      pid: null,
      detail: 'this server has no terminal daemon provider',
      processCeiling: null
    }
  }
  const health = await deps.checkHealth(endpoint.socketPath, endpoint.tokenPath)
  const record = deps.readRecord()
  const pid = record?.pid ?? null
  if (health.verdict !== 'unreachable') {
    return {
      verdict: 'live',
      pid,
      detail: LIVE_DETAIL[health.verdict],
      processCeiling: deps.confirmCeiling(record?.processCeiling ?? null)
    }
  }
  if (!record) {
    return {
      verdict: 'unverifiable',
      pid: null,
      detail: 'it did not answer and left no process record',
      processCeiling: null
    }
  }
  const processState = await deps.inspectPid(record)
  return processState === 'exited'
    ? {
        verdict: 'exited',
        pid,
        detail: `pid ${record.pid} is gone; Orca starts a new daemon with the next terminal`,
        processCeiling: null
      }
    : {
        verdict: 'unverifiable',
        pid,
        detail: `pid ${record.pid} ${processState === 'live' ? 'is running but did not answer' : 'could not be checked'}`,
        processCeiling: null
      }
}

/** A reused pid is a different process: on Linux the recorded start time tells them apart. */
export async function inspectDaemonRecordProcess(
  record: ParsedDaemonPid,
  platform: NodeJS.Platform = process.platform,
  readStat: typeof readLinuxStat = readLinuxStat
): Promise<'live' | 'exited' | 'unverifiable'> {
  const signal = inspectProcessLiveness(record.pid).status
  if (signal !== 'live' || platform !== 'linux' || !record.linuxStartTicks) {
    return signal
  }
  const stat = await readStat(record.pid)
  // Why not exited on a missing stat: the signal just proved the pid live; procfs may hide it.
  if (stat.status !== 'present') {
    return stat.status === 'missing' ? 'unverifiable' : 'live'
  }
  const startTicks = parseLinuxStartTicks(stat.value)
  return startTicks !== null && startTicks !== record.linuxStartTicks ? 'exited' : 'live'
}

const defaultDependencies: DaemonLivenessDependencies = {
  endpoint: getDaemonEndpointFacts,
  checkHealth: checkDaemonHealthWithCoverage,
  readRecord: readDaemonPidRecord,
  inspectPid: (record) => inspectDaemonRecordProcess(record),
  confirmCeiling: (state) => confirmPtyProcessCeiling(state)
}
