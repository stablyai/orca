import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  agentSessionProviderHandleKey,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

const START_TIME_READ_ATTEMPTS = 3

/** Persist spawn identity before handshake so recovery can stop a child that crashes during startup. */
export function codexSpawnedProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    onSpawned?: (process: AgentSessionProcessIdentity) => Promise<void>
  },
  readStartTime?: (pid: number) => Promise<number | null>
): {
  onSpawned: (pid: number) => Promise<void>
  read: (pid: number | undefined) => Promise<AgentSessionProcessIdentity>
} {
  let spawned: Promise<AgentSessionProcessIdentity> | undefined
  return {
    onSpawned: async (pid) => {
      spawned = codexProcessIdentity({ ...input, pid }, readStartTime)
      await input.onSpawned?.(await spawned)
    },
    read: (pid) => spawned ?? codexProcessIdentity({ ...input, pid }, readStartTime)
  }
}

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
  // Missing start time leaves recovery indeterminate; it releases the owner without signalling it.
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

type CodexProviderHandleLinkInput = {
  threadId: string
  fence: number
  linkId?: string
  observedAt: number
} & (
  | { origin?: 'adopted'; resumed: boolean; supersedesThreadId?: never }
  /** Only a newly created thread can supersede an unsaved predecessor. */
  | { origin?: never; resumed: false; supersedesThreadId: string }
)

export function codexProviderHandleLink(
  input: CodexProviderHandleLinkInput
): AgentSessionProviderHandleLink {
  return {
    linkId: input.linkId ?? `codex-${input.fence}-${input.threadId}`.slice(0, 128),
    handle: codexProviderHandle(input.threadId),
    origin: input.origin ?? (input.resumed ? 'resumed' : 'created'),
    mintedAtFence: input.fence,
    observedAt: input.observedAt,
    ...(input.supersedesThreadId
      ? {
          supersedesKey: agentSessionProviderHandleKey(
            codexProviderHandle(input.supersedesThreadId)
          )
        }
      : {})
  }
}
