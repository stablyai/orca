import {
  AGENT_CONVERSATION_REFUSAL_CODES as CODES,
  AGENT_READ_DEFAULT_LIMIT,
  type AgentReadEntry,
  type AgentReadResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { AgentReadJournalPosition } from '../../native-chat/agent-session-wire/publication/history/agent-read-journal-page'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'
import type { RpcContext } from '../rpc/core'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience
} from '../rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import {
  canReadWorkerTranscript,
  readWorkerTranscript
} from '../orchestration/workers/transcripts/worker-transcript-read'
import { createWorkerOutputSourceIdentity } from '../orchestration/workers/transcripts/worker-output-cursor'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { TerminalAgentTranscriptSource } from '../../agent-hooks/server/server-agent-identities'
import { sameProviderKey } from '../../agent-hooks/identity/agent-provider-key'
import {
  isReverseLookupUnavailable,
  type ReverseLookupUnavailable
} from '../../agent-hooks/identity/agent-identity-worker-protocol'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import {
  decodeReadCursor,
  encodeReadCursor,
  invalidCursor,
  type ReadCursor
} from './agent-read-cursor'

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
  const cursor = request.cursor ? decodeReadCursor(request.cursor, resolved.orcaSessionId) : null
  return resolved.kind === 'chat'
    ? readChat(ctx, resolved, limit, cursor)
    : readTerminalTranscript(ctx, resolved.orcaSessionId, limit, cursor)
}

async function readChat(
  ctx: RpcContext,
  resolved: Extract<ResolvedAgentConversation, { kind: 'chat' }>,
  limit: number,
  cursor: ReadCursor | null
): Promise<AgentReadResult> {
  const { record, store, orcaSessionId } = resolved
  if (cursor && cursor.s !== 'chat') {
    throw invalidCursor()
  }
  requireStructuredAgentAudience(ctx, record.provider)
  // The session that continues the conversation now: a /clear root reads its current chat.
  const running = resolveLineageRunningSession(store, record.sessionId)
  if (running.kind === 'other-host') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Agent ${orcaSessionId} runs on another host. Read it there, or add \`--environment <host>\`.`
    )
  }
  const sessionId = running.kind === 'here' ? running.sessionId : record.sessionId
  if (cursor && cursor.session !== sessionId) {
    throw sourceChanged(orcaSessionId)
  }
  const host = await requireInstalledStructuredHost(ctx, sessionId)
  const encode = (next: AgentReadJournalPosition): string =>
    encodeReadCursor({
      v: 1,
      id: orcaSessionId,
      s: 'chat',
      session: sessionId,
      journal: next.cursor,
      ...(next.within > 0 ? { w: next.within } : {})
    })
  const after = cursor ? { cursor: cursor.journal, within: cursor.w ?? 0 } : undefined
  // A follower re-reading with its cursor does no journal work until the journal moves.
  const head = after?.within === 0 ? await host.reads.journalCursor(sessionId) : null
  if (
    after &&
    head &&
    head.epoch === after.cursor.epoch &&
    // Only exact equality: a cursor ahead of the journal takes the reader's own reset path.
    head.sequence === after.cursor.sequence
  ) {
    return {
      orcaSessionId,
      kind: 'chat',
      agent: record.provider,
      source: 'chat',
      entries: [],
      cursor: encode(after),
      limited: false
    }
  }
  const page = await host.reads.agentReadPage(sessionId, { limit, ...(after ? { after } : {}) })
  if (!page.ok) {
    throw sourceChanged(orcaSessionId)
  }
  return {
    orcaSessionId,
    kind: 'chat',
    agent: record.provider,
    source: 'chat',
    entries: page.entries,
    cursor: encode(page.next),
    limited: page.limited
  }
}

async function readTerminalTranscript(
  ctx: RpcContext,
  orcaSessionId: string,
  limit: number,
  cursor: ReadCursor | null
): Promise<AgentReadResult> {
  if (cursor && cursor.s !== 'transcript') {
    throw invalidCursor()
  }
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
  const transcript = await readWorkerTranscript({
    agent: key.agent,
    sessionId: providerSession.id,
    transcriptPath: providerSession.transcriptPath,
    // The key's own distro keeps a WSL agent's guest path on that guest.
    ...(key.wslDistro ? { wslDistro: key.wslDistro } : {}),
    limit,
    ...(cursor?.s === 'transcript'
      ? { offset: cursor.p, ...(cursor.c ? { expectedBoundaryCheckpoint: cursor.c } : {}) }
      : {})
  })
  if (!transcript.ok) {
    if (cursor) {
      throw sourceChanged(orcaSessionId)
    }
    throw new AgentConversationRefusal(
      CODES.noTranscript,
      `Orca couldn't read agent ${orcaSessionId}'s transcript (${transcript.reason.replaceAll('_', ' ')}).`
    )
  }
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'agent-transcript',
    key.executionHost,
    key.wslDistro,
    key.agent,
    key.providerSessionId,
    key.locator,
    transcript.filePath,
    transcript.sourceFingerprint
  ])
  // The conversation must still name the file just read: its row may have moved on meanwhile.
  const after = await locate(source)
  if (
    isReverseLookupUnavailable(after) ||
    (cursor?.s === 'transcript' && cursor.i !== sourceIdentity) ||
    !after ||
    !sameProviderKey(after.key, key) ||
    after.providerSession.id !== providerSession.id ||
    after.providerSession.transcriptPath !== providerSession.transcriptPath
  ) {
    throw sourceChanged(orcaSessionId)
  }
  return {
    orcaSessionId,
    kind: 'terminal',
    agent: key.agent,
    source: 'transcript',
    entries: transcriptEntries(transcript.messages),
    cursor: encodeReadCursor({
      v: 1,
      id: orcaSessionId,
      s: 'transcript',
      i: sourceIdentity,
      p: transcript.nextOffset,
      ...(transcript.boundaryCheckpoint ? { c: transcript.boundaryCheckpoint } : {})
    }),
    limited: transcript.limited
  }
}

/** One entry per transcript message, its tool calls folded in, so `limit` messages are at most
 *  `limit` entries and the cursor after them skips nothing. */
function transcriptEntries(messages: readonly NativeChatMessage[]): AgentReadEntry[] {
  const entries: AgentReadEntry[] = []
  for (const message of messages) {
    if (message.role === 'reasoning' || message.role === 'tool') {
      continue
    }
    const text = message.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter((part) => part.length > 0)
      .join('\n')
      .trim()
    const tools = message.blocks.flatMap((block) =>
      block.type === 'tool-call'
        ? [{ name: block.name, ...(block.state ? { state: block.state } : {}) }]
        : []
    )
    if (text.length > 0 || tools.length > 0) {
      entries.push({
        kind: 'message',
        role: message.role,
        text,
        ...(tools.length > 0 ? { tools } : {})
      })
    }
  }
  return entries
}

function sourceChanged(orcaSessionId: string): AgentConversationRefusal {
  return new AgentConversationRefusal(
    CODES.sourceChanged,
    `What agent ${orcaSessionId}'s cursor pointed into has changed (the chat was cleared or its transcript moved). Read again without --cursor.`
  )
}
