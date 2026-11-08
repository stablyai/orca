import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import {
  boundLegacyImportBlock,
  boundLegacyImportBody,
  boundToolInput,
  type JournalPayloadLimits
} from '../item-lifecycle/journal-payload-bounds'
import { finishTranscriptWork, type TranscriptWork } from '../../transcript-work-scheduler'

export function legacyImportReplacementItem(
  message: NativeChatMessage,
  identity: AgentJournalItemIdentity,
  limits: JournalPayloadLimits
): JournalReplacementItem {
  return {
    identity,
    body: legacyItemBody(message, limits),
    observedAt: message.timestamp ?? undefined,
    // Imported history belongs to no active generation.
    ownerFence: 0
  }
}

export function* legacyImportReplacementItemWork(
  message: NativeChatMessage,
  identity: AgentJournalItemIdentity,
  limits: JournalPayloadLimits
): TranscriptWork<{ item: JournalReplacementItem; bytes: number }> {
  const body = yield* legacyItemBodyWork(message, limits, true)
  const item: JournalReplacementItem = {
    identity,
    body: body.value,
    observedAt: message.timestamp ?? undefined,
    ownerFence: 0
  }
  const bytes =
    body.value.kind === 'message'
      ? Buffer.byteLength(JSON.stringify({ ...item, body: { ...body.value, blocks: [] } })) +
        body.blockBytes
      : Buffer.byteLength(JSON.stringify(item))
  return { item, bytes }
}

export function legacyItemBody(
  message: NativeChatMessage,
  limits?: JournalPayloadLimits
): AgentJournalItemBody {
  return finishTranscriptWork(legacyItemBodyWork(message, limits)).value
}

function* legacyItemBodyWork(
  message: NativeChatMessage,
  limits?: JournalPayloadLimits,
  measure = false
): TranscriptWork<{ value: AgentJournalItemBody; blockBytes: number }> {
  const only = message.blocks.length === 1 ? message.blocks[0] : undefined
  if (only?.type === 'tool-call') {
    return {
      value: {
        kind: 'tool-call',
        name: only.name,
        input: limits ? boundToolInput(only.input, limits) : only.input,
        ...(only.callId !== undefined ? { callId: only.callId } : {}),
        state: 'completed'
      },
      blockBytes: 0
    }
  }
  return yield* legacyImportBodyWork(
    { kind: 'message', role: message.role, blocks: message.blocks },
    limits,
    measure
  )
}

function* legacyImportBodyWork(
  body: AgentJournalItemBody,
  limits?: JournalPayloadLimits,
  measure = false
): TranscriptWork<{ value: AgentJournalItemBody; blockBytes: number }> {
  if (body.kind !== 'message') {
    return { value: limits ? boundLegacyImportBody(body, limits) : body, blockBytes: 0 }
  }
  if (!limits && !measure) {
    return { value: body, blockBytes: 0 }
  }
  const blocks: NativeChatMessage['blocks'] = []
  let blockBytes = 0
  for (const block of body.blocks) {
    yield 1
    const bounded = limits ? boundLegacyImportBlock(block, limits) : block
    if (measure) {
      blockBytes += Buffer.byteLength(JSON.stringify(bounded)) + (blocks.length ? 1 : 0)
    }
    blocks.push(bounded)
  }
  return { value: { ...body, blocks }, blockBytes }
}

export function* prepareLegacyImportRowWork(
  row: JournalReplacementItem,
  limits: JournalPayloadLimits
): TranscriptWork<{ item: JournalReplacementItem; bytes: number }> {
  const body = yield* legacyImportBodyWork(row.body, limits, true)
  const item = { ...row, body: body.value }
  const bytes =
    body.value.kind === 'message'
      ? Buffer.byteLength(JSON.stringify({ ...item, body: { ...body.value, blocks: [] } })) +
        body.blockBytes
      : Buffer.byteLength(JSON.stringify(item))
  return { item, bytes }
}
