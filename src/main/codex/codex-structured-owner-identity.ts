import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

// What the lease records about the child Codex just handed back: the process it
// will later re-prove, and the provider handle link the journal binds to. Both
// must describe the thread Codex actually opened, never the one a client asked
// for.

/** The child echoes its spawn token here so the owner probe can tell a live
 *  child of THIS reservation from a same-pid stranger. */
export const CODEX_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

export async function codexProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    pid: number | undefined
  },
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error('codex app-server started without a pid')
  }
  return {
    hostId: input.identity.hostId,
    pid: input.pid,
    processStartTimeMs: await readStartTime(input.pid),
    spawnToken: input.spawnToken
  }
}

export function codexProviderHandleLink(input: {
  threadId: string
  resumed: boolean
  fence: number
  linkId?: string
  observedAt: number
}): AgentSessionProviderHandleLink {
  return {
    linkId: input.linkId ?? `codex-${input.fence}-${input.threadId}`.slice(0, 128),
    handle: { provider: 'codex', threadId: input.threadId },
    origin: input.resumed ? 'resumed' : 'created',
    mintedAtFence: input.fence,
    observedAt: input.observedAt
  }
}
