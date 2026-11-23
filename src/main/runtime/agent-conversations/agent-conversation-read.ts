import {
  AGENT_CONVERSATION_REFUSAL_CODES as CODES,
  AGENT_READ_DEFAULT_LIMIT,
  type AgentReadResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { RpcContext } from '../rpc/core'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience
} from '../rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { canReadWorkerTranscript } from '../orchestration/workers/transcripts/worker-transcript-read'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { TerminalAgentTranscriptSource } from '../../agent-hooks/server/server-agent-identities'
import { sameProviderKey } from '../../agent-hooks/identity/agent-provider-key'
import { tuiAgentDisplayName } from '../../../shared/agent-launch/catalog/tui-agent-display-names'
import { needsWslHostTranslation } from '../../native-chat/transcript-discovery/host-readable-transcript-path'
import {
  isReverseLookupUnavailable,
  type ReverseLookupUnavailable
} from '../../agent-hooks/identity/agent-identity-worker-protocol'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import { readTerminalAgentPage } from './terminal-agent-read-page'

type ReadRequest = { limit?: number; cursor?: string }

/** One page of what an agent said, by its conversation, never by a pane: a chat's own history,
 *  or a terminal agent's transcript. Reading needs no running agent and never starts one.
 *
 *  Trust boundary: a terminal agent's transcript is the file its own hooks reported for that
 *  conversation. It is read only through that provider's transcript decoder, which yields the
 *  provider's messages and nothing else; there is no raw-file fallback. Callers need the same
 *  workspace permission `orchestration worker-read` uses for the same reader. */
export async function readAgentConversation(
  ctx: RpcContext,
  resolved: ResolvedAgentConversation,
  request: ReadRequest
): Promise<AgentReadResult> {
  const limit = request.limit ?? AGENT_READ_DEFAULT_LIMIT
  return resolved.kind === 'chat'
    ? readChat(ctx, resolved, limit, request.cursor)
    : readTerminalTranscript(ctx, resolved.orcaSessionId, limit, request.cursor)
}

async function readChat(
  ctx: RpcContext,
  resolved: Extract<ResolvedAgentConversation, { kind: 'chat' }>,
  limit: number,
  cursor: string | undefined
): Promise<AgentReadResult> {
  const { record, store, orcaSessionId } = resolved
  requireStructuredAgentAudience(ctx, record.provider)
  // The session that continues the conversation now: a /clear root reads its current chat.
  const running = resolveLineageRunningSession(store, record.sessionId)
  if (running.kind === 'other-host') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Agent ${orcaSessionId} runs on another host. Read it there, or add \`--environment <host>\`.`
    )
  }
  if (running.kind === 'unverifiable') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Orca can't verify agent ${orcaSessionId}'s current conversation after /clear. Open the agent in Orca and try reading it again.`
    )
  }
  const sessionId = running.sessionId
  const host = await requireInstalledStructuredHost(ctx, sessionId)
  const page = await host.reads.agentReadPage(sessionId, {
    orcaSessionId,
    limit,
    ...(cursor !== undefined ? { cursor } : {})
  })
  return {
    orcaSessionId,
    kind: 'chat',
    agent: record.provider,
    source: 'chat',
    entries: page.entries,
    limited: page.limited,
    nextCursor: page.nextCursor,
    ...(page.state ? { state: page.state } : {})
  }
}

async function readTerminalTranscript(
  ctx: RpcContext,
  orcaSessionId: string,
  limit: number,
  cursor: string | undefined
): Promise<AgentReadResult> {
  const locate = (
    known?: TerminalAgentTranscriptSource
  ): Promise<TerminalAgentTranscriptSource | ReverseLookupUnavailable | null | undefined> =>
    agentHookServer.terminalAgentTranscriptSource(
      orcaSessionId,
      () => ctx.runtime.readLocalSleepingAgentSessions(),
      known
    )
  const source = await locate()
  if (source === undefined) {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Orca can't look up where agent ${orcaSessionId}'s transcript is right now. Try again in a moment.`
    )
  }
  if (isReverseLookupUnavailable(source)) {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Orca can't look up agent ${orcaSessionId}'s saved transcript with this identity file in the current version. Open it with the newer Orca version that wrote the file, or read an agent that's open now from \`orca agent list\`.`
    )
  }
  if (source === null || !canReadWorkerTranscript(source.key.agent)) {
    throw new AgentConversationRefusal(
      CODES.noTranscript,
      source === null
        ? `Orca has no transcript location for agent ${orcaSessionId} right now.`
        : `Orca can't read ${source.key.agent} transcripts, so agent ${orcaSessionId} has nothing to read here.`
    )
  }
  const { key, providerSession } = source
  if (
    !key.wslDistro &&
    providerSession.transcriptPath &&
    needsWslHostTranslation(providerSession.transcriptPath)
  ) {
    // A saved guest path with no distro names no file this host can open.
    throw new AgentConversationRefusal(
      CODES.noTranscript,
      `Orca can't read ${tuiAgentDisplayName(key.agent) ?? key.agent} agent ${orcaSessionId}'s transcript because its saved location doesn't identify which WSL distro holds it. Run \`orca agent show ${orcaSessionId}\` to find any open terminal for this agent and view it there.`
    )
  }
  const page = await readTerminalAgentPage({
    orcaSessionId,
    agent: key.agent,
    sessionId: providerSession.id,
    transcriptPath: providerSession.transcriptPath,
    // The key's own distro keeps a WSL agent's guest path on that guest.
    ...(key.wslDistro ? { wslDistro: key.wslDistro } : {}),
    limit,
    ...(cursor !== undefined ? { cursor } : {})
  })
  // What vouched for the file may have ended, or the conversation moved to another file, meanwhile.
  const after = await locate(source)
  if (
    isReverseLookupUnavailable(after) ||
    !after ||
    !sameProviderKey(after.key, key) ||
    after.providerSession.id !== providerSession.id ||
    after.providerSession.transcriptPath !== providerSession.transcriptPath
  ) {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Agent ${orcaSessionId}'s transcript changed while Orca was reading it. Read it again.`
    )
  }
  return {
    orcaSessionId,
    kind: 'terminal',
    agent: key.agent,
    source: 'transcript',
    entries: page.entries,
    limited: page.limited,
    nextCursor: page.nextCursor,
    ...(page.state ? { state: page.state } : {})
  }
}
