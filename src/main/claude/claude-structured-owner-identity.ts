import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

export function claudeProviderHandleLink(input: {
  sessionId: string
  leafUuid: string | null
  resumed: boolean
  origin?: 'adopted'
  fence: number
  linkId?: string
  observedAt: number
}): AgentSessionProviderHandleLink {
  return {
    linkId:
      input.linkId ??
      `claude-${input.fence}-${input.sessionId}-${input.leafUuid ?? 'empty'}`.slice(0, 128),
    handle: claudeProviderHandle(input.sessionId, input.leafUuid),
    origin: input.origin ?? (input.resumed ? 'resumed' : 'created'),
    mintedAtFence: input.fence,
    observedAt: input.observedAt
  }
}

/** The child echoes its spawn token here so the owner probe can tell a live
 *  child of this reservation from a same-pid stranger. */
export const CLAUDE_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

const START_TIME_READ_ATTEMPTS = 3

export async function claudeProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    pid: number | undefined
  },
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error('claude app-server started without a pid')
  }
  // Best-effort: without it a later owner probe is indeterminate, and recovery releases such an
  // owner without signalling it, so an unreadable start time must not refuse the session.
  let processStartTimeMs: number | null = null
  for (
    let attempt = 0;
    attempt < START_TIME_READ_ATTEMPTS && processStartTimeMs === null;
    attempt += 1
  ) {
    processStartTimeMs = await readStartTime(input.pid)
  }
  return {
    hostId: input.identity.hostId,
    pid: input.pid,
    processStartTimeMs,
    spawnToken: input.spawnToken
  }
}
