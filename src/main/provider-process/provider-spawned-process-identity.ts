import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

// What the lease records about a provider child: the process a later owner probe re-proves.

/** The child echoes its spawn token here so the owner probe can tell a live child of THIS
 *  reservation from a same-pid stranger. */
export const PROVIDER_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

const START_TIME_READ_ATTEMPTS = 3

type SpawnedIdentityInput = {
  identity: AgentSessionJournalIdentity
  spawnToken: string
  onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
}

/**
 * The child's identity, read once. A connection that reports its spawn before the handshake makes
 * it durable there through `onSpawned`, so a crash mid-start leaves an owner recovery can stop; one
 * that reports no spawn is identified once it is open.
 */
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
    // Why: recording null makes every later owner probe indeterminate — a durable latch.
    // Failing here reaps the child and leaves a retryable refusal instead.
    throw new Error(`${label} start time for pid ${input.pid} could not be read`)
  }
  return {
    hostId: input.identity.hostId,
    pid: input.pid,
    processStartTimeMs,
    spawnToken: input.spawnToken
  }
}
