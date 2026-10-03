import type { IPty } from 'node-pty'
import type { AgentForegroundObservation } from '../../shared/agent-foreground-identity'
import { captureAgentForegroundIdentity } from '../../shared/agent-foreground-identity'
import type { AgentProcessIdentity, AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { AgentProcessObservation } from '../../shared/agent-process-presence-probe'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'
import { readWindowsPtyJobProcessIds } from './windows-pty-job-membership'
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'

// Temporary review gate: presence-windows-exit-proof must establish the shipped job contract.
export function windowsAgentPresenceProofEnabled(): boolean {
  return process.platform === 'win32' && process.env.ORCA_WINDOWS_AGENT_PRESENCE_PROOF === '1'
}

function readWindowsOwner(pid: number): Promise<AgentProcessObservation> {
  const start = readWindowsProcessCreationTime(pid)
  return Promise.resolve(
    start === null
      ? { verdict: 'unverifiable' }
      : {
          verdict: 'live',
          startTime: String(start),
          zombie: false
        }
  )
}

export async function captureWindowsAgentPresence(
  proc: IPty,
  observation: AgentForegroundObservation
) {
  if (!windowsAgentPresenceProofEnabled()) {
    return undefined
  }
  const members = readWindowsPtyJobProcessIds(proc)
  if (!observation.processId || !members?.has(observation.processId)) {
    return undefined
  }
  // Why: the job proves lifetime, not that the process is in this terminal; a detached
  // `Start-Process` child stays in the job. One console read per capture, never per poll.
  const attached = await readWindowsConsoleAttachedProcessIds(proc.pid).catch(() => null)
  if (!attached?.has(observation.processId)) {
    return undefined
  }
  const presence = await captureAgentForegroundIdentity(
    async () => observation,
    readWindowsOwner,
    'win32'
  )
  return presence?.process && readWindowsPtyJobProcessIds(proc)?.has(presence.process.pid)
    ? presence
    : undefined
}

export function probeWindowsAgentPresence(
  identity: AgentProcessIdentity,
  members: ReadonlySet<number> | null,
  readCreation: (pid: number) => number | null = readWindowsProcessCreationTime
): AgentProcessVerdict {
  if (identity.platform !== 'win32' || !members) {
    return 'unverifiable'
  }
  if (!members.has(identity.pid)) {
    return 'exited'
  }
  const created = readCreation(identity.pid)
  if (created === null) {
    return 'unverifiable'
  }
  return String(created) === identity.startTime ? 'live' : 'exited'
}

export function probeWindowsPtyAgentPresence(
  proc: IPty,
  identity: AgentProcessIdentity
): AgentProcessVerdict {
  return windowsAgentPresenceProofEnabled()
    ? probeWindowsAgentPresence(identity, readWindowsPtyJobProcessIds(proc))
    : 'unverifiable'
}
