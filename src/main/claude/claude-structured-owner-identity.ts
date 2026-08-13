import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

export const CLAUDE_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

export async function claudeProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    pid: number | undefined
  },
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error('claude stream-json started without a pid')
  }
  return {
    hostId: input.identity.hostId,
    pid: input.pid,
    processStartTimeMs: await readStartTime(input.pid),
    spawnToken: input.spawnToken
  }
}

export function claudeProviderHandleLink(input: {
  sessionId: string
  leafUuid: string | null
  resumed: boolean
  fence: number
  linkId?: string
  observedAt: number
}): AgentSessionProviderHandleLink {
  return {
    linkId:
      input.linkId ??
      `claude-${input.fence}-${input.sessionId}-${input.leafUuid ?? 'empty'}`.slice(0, 128),
    handle: { provider: 'claude', sessionId: input.sessionId, leafUuid: input.leafUuid },
    origin: input.resumed ? 'resumed' : 'created',
    mintedAtFence: input.fence,
    observedAt: input.observedAt
  }
}
