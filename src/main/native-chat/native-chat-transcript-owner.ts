import { extname } from 'node:path'
import type { AgentType } from '../../shared/native-chat-types'
import {
  isWslHookRelayConnectionId,
  WSL_HOOK_RELAY_CONNECTION_PREFIX
} from '../../shared/wsl-hook-relay-contract'
import { agentHookServer } from '../agent-hooks/server'
import type { AgentHookTranscriptOwnerEvidence } from '../agent-hooks/server'

export type NativeChatTranscriptOwner =
  | { kind: 'legacy-local' }
  | { kind: 'local'; transcriptPath?: string; wslDistro?: string }
  | { kind: 'ssh'; connectionId: string; transcriptPath: string | null }
  | { kind: 'unknown' }

type NativeChatOwnerArgs = {
  agent?: AgentType
  sessionId: string
  paneKey?: string
  transcriptPath?: string
}

function exactTranscriptPath(value: string | undefined): string | undefined {
  const transcriptPath = value?.trim()
  return transcriptPath && extname(transcriptPath) === '.jsonl' ? transcriptPath : undefined
}

export function resolveNativeChatTranscriptOwner(
  args: NativeChatOwnerArgs
): NativeChatTranscriptOwner {
  const sessionId = args.sessionId.trim()
  if (!sessionId) {
    return { kind: 'unknown' }
  }
  const rows = args.paneKey
    ? agentHookServer.getStatusSnapshotForPane(args.paneKey)
    : agentHookServer.getStatusSnapshot()
  const liveMatches = rows.filter(
    (row) =>
      row.providerSession?.id === sessionId &&
      (!args.agent || !row.agentType || row.agentType === args.agent)
  )
  const retainedMatches = agentHookServer
    .getTranscriptOwnerEvidence(args.paneKey)
    .filter(
      (owner) => owner.sessionId === sessionId && (!args.agent || owner.agentType === args.agent)
    )
  if (liveMatches.length === 0 && retainedMatches.length === 0) {
    if (agentHookServer.hasUnresolvedRemoteTranscriptOwner(args.paneKey)) {
      return { kind: 'unknown' }
    }
    return args.paneKey ? { kind: 'unknown' } : { kind: 'legacy-local' }
  }
  const owners = new Map<string, NativeChatTranscriptOwner>()
  for (const row of liveMatches) {
    const connectionId = row.connectionId ?? null
    const transcriptPath = exactTranscriptPath(row.providerSession?.transcriptPath) ?? null
    owners.set(
      `${connectionId ?? 'local'}\0${transcriptPath ?? ''}`,
      ownerFromEvidence({
        paneKey: row.paneKey,
        agentType: row.agentType ?? args.agent ?? 'unknown',
        sessionId,
        ...(transcriptPath ? { transcriptPath } : {}),
        connectionId,
        observedAt: row.receivedAt
      })
    )
  }
  for (const owner of retainedMatches) {
    const transcriptPath = exactTranscriptPath(owner.transcriptPath) ?? null
    owners.set(
      `${owner.connectionId ?? 'local'}\0${transcriptPath ?? ''}`,
      ownerFromEvidence({ ...owner, ...(transcriptPath ? { transcriptPath } : {}) })
    )
  }
  if (owners.size !== 1) {
    return { kind: 'unknown' }
  }
  return owners.values().next().value ?? { kind: 'unknown' }
}

export async function resolveHydratedNativeChatTranscriptOwner(
  args: NativeChatOwnerArgs,
  signal?: AbortSignal
): Promise<NativeChatTranscriptOwner> {
  await agentHookServer.awaitTranscriptOwnerHydration()
  signal?.throwIfAborted()
  return resolveNativeChatTranscriptOwner(args)
}

function ownerFromEvidence(owner: AgentHookTranscriptOwnerEvidence): NativeChatTranscriptOwner {
  const transcriptPath = exactTranscriptPath(owner.transcriptPath)
  const connectionId = owner.connectionId?.trim()
  if (!connectionId) {
    return { kind: 'local', ...(transcriptPath ? { transcriptPath } : {}) }
  }
  if (isWslHookRelayConnectionId(connectionId)) {
    const wslDistro = connectionId.slice(WSL_HOOK_RELAY_CONNECTION_PREFIX.length).trim()
    return {
      kind: 'local',
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(wslDistro ? { wslDistro } : {})
    }
  }
  return { kind: 'ssh', connectionId, transcriptPath: transcriptPath ?? null }
}
