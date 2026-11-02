import type { AgentSessionProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleRoot } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  selectStoppedHistory,
  withStoppedHistory
} from '../../../shared/agent-session/lifecycle/agent-session-stopped-history'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { providerTimelineKeyPart } from '../agent-session-timeline/provider-timeline-identity'
import {
  contextTransferDigest,
  renderRecoveryItem,
  renderRecoveryCoverage,
  withRecoveryContext
} from '../agent-session-context-transfer-text'
import type { ContextTransferRecord } from './context-transfer-record'
import { contextTransferLookup } from './context-transfer-state'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'

// Every rendered history block and carrier starts with its saved delivery ID.
const MARKER_ID = /<orca_context_handoff id="([^"]+)">/g

export type ContextTransferEcho =
  | { kind: 'history' }
  | { kind: 'carrier'; clientMessageId: string; body: AgentJournalItemBody }

/** Only exact saved bytes on their native target can suppress history or accept an uncertain carrier. */
export function matchContextTransferEcho(input: {
  owner: () => AgentSessionRecord | null
  sessionId: string
  records: readonly ContextTransferRecord[]
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  fence?: number
  itemBody: (id: string) => AgentJournalItemBody | null
  carries: (clientMessageId: string) => readonly string[]
}): ContextTransferEcho | null {
  const { body } = input
  if (body.kind !== 'message') {
    return null
  }
  const records = input.records
  if (!records.length) {
    return null
  }
  const text = body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
  const lookup = contextTransferLookup(records)
  const ids = new Set(Array.from(text.matchAll(MARKER_ID), (match) => match[1]))
  for (const id of ids) {
    const delivery = id === undefined ? undefined : lookup.deliveries.get(id)
    const target = delivery && lookup.targets.get(delivery.targetId)
    if (
      !delivery ||
      !target?.targetLink ||
      !matchesContextTransferTarget({ ...input, handle: target.targetLink.handle })
    ) {
      continue
    }
    const handoff = lookup.handoffs.get(target.handoffId)
    if (
      !handoff ||
      delivery.writeStartedAt === undefined ||
      delivery.selection.digest !== contextTransferDigest(delivery.selection.encodedContext)
    ) {
      continue
    }
    if (
      delivery.mode === 'inject' &&
      (text === renderRecoveryCoverage(delivery.id, delivery.selection.coverageText) ||
        handoff.capture.messages.some(
          (message) =>
            delivery.selection.itemIds.includes(message.itemId) &&
            message.role === body.role &&
            text === renderRecoveryItem(delivery.id, message)
        ))
    ) {
      return { kind: 'history' }
    }
    if (delivery.mode === 'inline' && delivery.carrierInputId && body.role === 'user') {
      const original = input.itemBody(agentJournalSubmissionKey(delivery.carrierInputId))
      if (original?.kind !== 'message') {
        continue
      }
      const carried = selectStoppedHistory(
        input.carries(delivery.carrierInputId).flatMap((clientMessageId) => {
          const saved = input.itemBody(agentJournalSubmissionKey(clientMessageId))
          return saved?.kind === 'message'
            ? [
                {
                  clientMessageId,
                  words: saved.blocks
                    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
                    .join('\n')
                }
              ]
            : []
        }),
        original
      )
      const carrier = carried ? withStoppedHistory(original, carried.messages) : original
      const encoded = withRecoveryContext(carrier, delivery.selection.encodedContext)
        .blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
      if (text === encoded) {
        return { kind: 'carrier', clientMessageId: delivery.carrierInputId, body: original }
      }
    }
  }
  return null
}

export function matchesContextTransferTarget(input: {
  owner: () => AgentSessionRecord | null
  sessionId: string
  identity: AgentJournalItemIdentity
  handle: AgentSessionProviderHandle
  fence?: number
}): boolean {
  const { identity, handle } = input
  let sameTarget =
    identity.provider === 'codex' &&
    handle.transport === 'codex-app-server' &&
    identity.threadId === handle.nativeId
  if (identity.provider === 'legacy') {
    if (handle.transport === 'acp') {
      sameTarget =
        identity.agent === handle.agent &&
        identity.recordId.startsWith(`item:p:${providerTimelineKeyPart(handle.nativeId)}:`)
    }
    if (handle.transport === 'jsonl-rpc' && handle.agent === 'pi' && identity.agent === 'pi') {
      sameTarget = identity.sessionId === handle.nativeId
      if (!sameTarget && identity.sessionId === input.sessionId && input.fence !== undefined) {
        const owner = input.owner()
        const head = owner && agentSessionProviderHandleChainHead(owner.providerHandleChain)
        sameTarget =
          owner?.lease.runtimeFence === input.fence &&
          !!head &&
          agentSessionProviderHandleRoot(head.handle) === agentSessionProviderHandleRoot(handle)
      }
    }
  }
  return sameTarget
}

export function contextTransferEchoDispatch(
  echo: Extract<ContextTransferEcho, { kind: 'carrier' }>,
  identity: AgentJournalItemIdentity,
  fence: number
) {
  return {
    clientMessageId: echo.clientMessageId,
    state: 'accepted' as const,
    providerIdentity: identity,
    fence
  }
}
