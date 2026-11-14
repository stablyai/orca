import {
  AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS,
  assistantReplyProse,
  nativeChatUserMessagePreview,
  truncateOutlinePreview,
  type NativeChatUserMessagePreview
} from '../../../shared/agent-session/agent-session-conversation-outline'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { projectStructuredItemToNativeChat } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { nativeChatToolFoldKind } from '../../../shared/native-chat/tools/native-chat-tool-fold'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../shared/native-chat/native-chat-types'

export type JournalOutlineSource = {
  item: AgentJournalRenderItem
  message: NativeChatMessage | null
  preview: NativeChatUserMessagePreview | null
  reply: string | null
}

/** Keep tool identities and classification prefixes so neighbours still decide which rows draw. */
function outlineBlocks(blocks: readonly NativeChatBlock[]): NativeChatBlock[] {
  return blocks.flatMap((block): NativeChatBlock[] => {
    switch (block.type) {
      case 'text':
        return [
          {
            type: 'text',
            text: block.text.trimStart().slice(0, 320),
            ...(block.contextClear ? { contextClear: block.contextClear } : {}),
            ...(block.failure?.kind === 'providerRetrying' ? { failure: block.failure } : {})
          }
        ]
      case 'tool-call':
        return [{ type: 'tool-call', name: '', input: null, callId: block.callId }]
      case 'tool-result':
        return [{ type: 'tool-result', output: '', callId: block.callId }]
      case 'image-ref':
        return [{ type: 'image-ref' }]
      case 'background-task':
      case 'subagent':
      case 'subagent-group':
        return []
    }
  })
}

/** Classify originals once, before clipping: noise and tool-only rows must not become prompts. */
export function journalDomainOutlineSource(item: AgentJournalRenderItem): string | null {
  const { body, ...placement } = item
  const turn = readAgentJournalTurn(body)
  const compact: AgentJournalRenderItem = {
    ...placement,
    body: turn
      ? {
          kind: 'turn',
          turnId: turn.turnId,
          state: turn.state,
          ...(turn.userItemId === undefined ? {} : { userItemId: turn.userItemId }),
          ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
          ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt })
        }
      : body.kind === 'message'
        ? {
            kind: 'message',
            role: body.role,
            blocks: [],
            ...(body.command ? { command: body.command } : {})
          }
        : body.kind === 'status' && isAgentSessionContextClear(body)
          ? { kind: 'status', text: '', contextClear: body.contextClear }
          : { kind: 'status', text: '' }
  }
  const projected = isRootAgentJournalItem(item) ? projectStructuredItemToNativeChat(item) : null
  let message: JournalOutlineSource['message'] = null
  let preview: NativeChatUserMessagePreview | null = null
  if (projected && nativeChatToolFoldKind(projected) !== 'pass') {
    message = { ...projected, blocks: outlineBlocks(projected.blocks) }
    if (projected.role === 'user') {
      const full = nativeChatUserMessagePreview(projected)
      preview = {
        text: truncateOutlinePreview(full.text, AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS),
        imageCount: full.imageCount
      }
    }
  }
  return JSON.stringify({
    item: compact,
    message,
    preview,
    reply: projected?.role === 'assistant' ? assistantReplyProse(projected.blocks) || null : null
  } satisfies JournalOutlineSource)
}

export function journalDomainOutlineSubmission(submission: AgentJournalSubmission): string {
  const {
    clientMessageId,
    fence,
    payloadFingerprint,
    dispatchState,
    providerItemId,
    reason,
    submittedAt,
    resolvedAt,
    submittedSequence,
    acceptedSequence,
    queuedMessageId,
    keptAsQueuedMessageId,
    handoverRecorded,
    handedOverAt,
    answeredInTurn,
    rejection
  } = submission
  return JSON.stringify({
    clientMessageId,
    fence,
    payloadFingerprint,
    dispatchState,
    providerItemId,
    reason,
    submittedAt,
    resolvedAt,
    submittedSequence,
    acceptedSequence,
    queuedMessageId,
    keptAsQueuedMessageId,
    handoverRecorded,
    handedOverAt,
    answeredInTurn,
    rejection
  } satisfies AgentJournalSubmission)
}
