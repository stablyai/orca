import {
  AGENT_CONVERSATION_REFUSAL_CODES as CODES,
  AGENT_READ_DEFAULT_LIMIT,
  type AgentReadEntry,
  type AgentReadResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { agentSessionPromptQuestions } from '../../../shared/agent-session/agent-session-question-answer'
import { isActionableStructuredAgentSessionPrompt } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
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
  const history = await host.history({
    sessionId,
    direction: cursor ? 'after' : 'tail',
    ...(cursor ? { cursor: cursor.journal } : {}),
    limit: AGENT_SESSION_HISTORY_MAX_LIMIT
  })
  if (!history.ok && cursor) {
    throw sourceChanged(orcaSessionId)
  }
  const { page } = history
  const all = chatEntries(page.items, page.actionablePromptIds)
  // A first read is the latest entries; a cursor read is everything after it, so none are skipped.
  const entries = cursor ? all : all.slice(-limit)
  const next = cursor ? page.window.nextCursor : (page.liveCursor ?? page.window.newest)
  return {
    orcaSessionId,
    kind: 'chat',
    agent: record.provider,
    source: 'chat',
    entries,
    cursor: next
      ? encodeReadCursor({ v: 1, id: orcaSessionId, s: 'chat', session: sessionId, journal: next })
      : null,
    limited: cursor ? page.hasNewer : page.hasOlder || all.length > limit
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
  const locate = (): Promise<TerminalAgentTranscriptSource | null | undefined> =>
    agentHookServer.terminalAgentTranscriptSource(orcaSessionId, () =>
      ctx.runtime.listSleepingAgentSessionRecords()
    )
  const source = await locate()
  if (source === undefined) {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Orca can't look up where agent ${orcaSessionId}'s transcript is right now. Try again in a moment.`
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
  const after = await locate()
  if (
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

/** The conversation as a reader follows it: messages, the tools the agent ran, and the approvals
 *  and questions it raised. Status frames, turn markers and subagent rows are left out. */
function chatEntries(
  items: readonly AgentJournalRenderItem[],
  actionablePromptIds?: readonly string[]
): AgentReadEntry[] {
  // An ended agent's unanswered prompts stay pending in the journal but can no longer be answered.
  const waiting = (item: AgentJournalRenderItem, state: string): boolean =>
    state === 'pending' &&
    isActionableStructuredAgentSessionPrompt(item.itemId, actionablePromptIds)
  const entries: AgentReadEntry[] = []
  for (const item of items) {
    if (!isRootAgentJournalItem(item)) {
      continue
    }
    const body = item.body
    if (body.kind === 'message') {
      const text = body.blocks
        .map((block) =>
          block.type === 'text' ? block.text : block.type === 'image-ref' ? '[image]' : ''
        )
        .filter((part) => part.length > 0)
        .join('\n')
        .trim()
      // Reasoning is the model's scratch work, folded away in the app too.
      if (text.length > 0 && body.role !== 'reasoning') {
        entries.push({ kind: 'message', role: body.role, text })
      }
    } else if (body.kind === 'status' && body.tone === 'error') {
      entries.push({ kind: 'error', text: String(body.text) })
    } else if (body.kind === 'tool-call') {
      entries.push({ kind: 'tool', name: body.name, state: body.state })
    } else if (body.kind === 'approval') {
      entries.push({
        kind: 'approval',
        text: body.title,
        pending: waiting(item, body.resolution.state)
      })
    } else if (body.kind === 'question') {
      entries.push({
        kind: 'question',
        // Grouped prompts keep their real questions in `questions`; `question` is then a heading.
        text: agentSessionPromptQuestions(body)
          .map((question) => question.question)
          .join('\n'),
        pending: waiting(item, body.resolution.state)
      })
    }
  }
  return entries
}

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
    if (text.length > 0) {
      entries.push({ kind: 'message', role: message.role, text })
    }
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        entries.push({
          kind: 'tool',
          name: block.name,
          ...(block.state ? { state: block.state } : {})
        })
      }
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
