import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session/ownership/agent-session-process-identity-probe'

const START_TIME_READ_ATTEMPTS = 3

type SpawnedIdentityInput = {
  identity: AgentSessionJournalIdentity
  spawnToken: string
  onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
}

/** Persist pre-handshake spawns through onSpawned so recovery can stop children after a mid-start crash. */
export function providerSpawnedProcessIdentity(
  input: SpawnedIdentityInput,
  label: string,
  readStartTime?: (pid: number) => Promise<number | null>
): {
  onSpawned: (pid: number) => Promise<void>
  read: (pid: number | undefined) => Promise<AgentSessionProcessIdentity>
} {
  let spawned: Promise<AgentSessionProcessIdentity> | undefined
  return {
    onSpawned: async (pid) => {
      spawned = providerProcessIdentity({ ...input, pid }, label, readStartTime)
      await input.onSpawned?.(await spawned)
    },
    read: (pid) => spawned ?? providerProcessIdentity({ ...input, pid }, label, readStartTime)
  }
}

export async function providerProcessIdentity(
  input: { identity: AgentSessionJournalIdentity; spawnToken: string; pid: number | undefined },
  label: string,
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error(`${label} started without a pid`)
  }
  let processStartTimeMs: number | null = null
  for (
    let attempt = 0;
    attempt < START_TIME_READ_ATTEMPTS && processStartTimeMs === null;
    attempt += 1
  ) {
    processStartTimeMs = await readStartTime(input.pid)
  }
  if (processStartTimeMs === null) {
    // A null start time would latch recovery as indeterminate; fail and reap now so it remains retryable.
    throw new Error(`${label} start time for pid ${input.pid} could not be read`)
  }
  return {
    hostId: input.identity.hostId,
    pid: input.pid,
    processStartTimeMs,
    spawnToken: input.spawnToken
  }
}
