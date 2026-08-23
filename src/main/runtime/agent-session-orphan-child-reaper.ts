/**
 * Stops provider children that carry an Orca spawn token no lease claims.
 *
 * A child spawned under a reservation whose record was lost — the primary store file went with it,
 * or the crash beat the durable write — is unreachable but still connected to the provider session.
 * Recovery will later grant a new owner for that same session, so without this the host ends up
 * with two live children on one provider thread. Only a token match justifies signalling a process;
 * neither age nor CPU is evidence, and a host that cannot enumerate tokens stops nothing.
 */

import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  scanAgentSessionSpawnTokenProcesses,
  type AgentSessionSpawnTokenScan
} from './agent-session-spawn-token-process-scan'

export type AgentSessionOrphanStopSignal = 'SIGTERM' | 'SIGKILL'

function defaultStop(pid: number, signal: AgentSessionOrphanStopSignal): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone, or not ours to signal. Either way there is nothing further to do.
  }
}

/** Returns the pids signalled, so the caller can report what it reaped. */
export async function stopOrphanAgentSessionChildren(input: {
  store: Pick<AgentSessionRecordStore, 'listOrphanSpawnTokens'>
  scan?: () => Promise<AgentSessionSpawnTokenScan | null>
  stop?: (pid: number, signal: AgentSessionOrphanStopSignal) => void
}): Promise<number[]> {
  const observed = await (input.scan ?? scanAgentSessionSpawnTokenProcesses)()
  if (observed === null || observed.size === 0) {
    return []
  }
  const stop = input.stop ?? defaultStop
  const stopped: number[] = []
  for (const token of input.store.listOrphanSpawnTokens([...observed.keys()])) {
    for (const pid of observed.get(token) ?? []) {
      stop(pid, 'SIGTERM')
      stopped.push(pid)
    }
  }
  return stopped
}
