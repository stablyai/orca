import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { HISTORY_CATCH_UP_MAX_OPERATIONS } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import type { AgentSessionJournalReads } from '../../native-chat/agent-session-journal/journal-reads'
import { createJournalHistoryItems } from '../../native-chat/agent-session-journal/journal-history-items'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { claudeSourceBlockId } from '../structured/journal/claude-streamed-block-identity'
import {
  claudeMessageIdentity,
  claudeRecord,
  claudeText,
  claudeThinkingIdentity,
  claudeToolIdentity,
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope
} from '../structured/journal/claude-structured-item-translation'
import { claudeMessageWithoutSyntheticText } from '../structured/journal/claude-internal-message-content'
import { claudeTranscriptPrompt } from './claude-transcript-prompt'

/** Every saved item used by the projection is a conditional commit dependency, even if equal. */
export async function createClaudeTranscriptItemReader(
  reads: Pick<AgentSessionJournalReads, 'historyItems' | 'claudeHistoryPrompts'>,
  sessionId: string,
  promptUuids: readonly string[],
  itemIds: readonly string[]
) {
  const dependencies = new Map<string, AgentJournalRenderItem>()
  const journal = createJournalHistoryItems()
  const loaded = new Set<string>()
  const localPrompts = new Map(
    (await reads.claudeHistoryPrompts(sessionId, promptUuids)).map(({ uuid, itemId }) => [
      uuid,
      itemId
    ])
  )
  const load = async (keys: readonly string[]) => {
    const missing = keys.filter((key) => !loaded.has(key))
    if (!missing.length) {
      return
    }
    const items = await reads.historyItems(missing)
    journal.adopt(items)
    for (const { key } of items) {
      loaded.add(key)
    }
  }
  const initial = await reads.historyItems([...itemIds, ...localPrompts.values()], {
    includeOpeners: true
  })
  journal.adopt(initial)
  for (const { key } of initial) {
    loaded.add(key)
  }
  const saved = (key: string) => {
    const held = dependencies.get(key)
    if (held) {
      return held
    }
    const item = journal.item(key)
    if (item) {
      dependencies.set(key, item)
    }
    if (dependencies.size > HISTORY_CATCH_UP_MAX_OPERATIONS) {
      throw new Error('too-large')
    }
    return item
  }
  // Lost acknowledgements lose aliases, but the prompt UUID can still name its saved submission.
  const localPrompt = (uuid: string) => {
    const key = localPrompts.get(uuid)
    // Depend on the persisted key, without creating a provider alias or acknowledging delivery.
    return key ? saved(key) : null
  }
  const scopeOf = (item: AgentJournalRenderItem): AgentJournalTurnScope => {
    const scope = item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    if (scope.kind === 'turn') {
      const parent = saved(scope.turnItemId)
      if (!parent || parent.body.kind !== 'turn' || parent.body.state === 'running') {
        throw new Error('unsettled-history-turn')
      }
    }
    return scope
  }
  const promptScope = (item: AgentJournalRenderItem, queued: boolean) => {
    if (queued) {
      const scope = scopeOf(item)
      return scope.kind === 'turn' ? scope : undefined
    }
    let scope: AgentJournalTurnScope | undefined
    for (const turnItemId of journal.openedTurnIds(item.itemId)) {
      if (saved(turnItemId)) {
        scope = scopeOf({ ...item, turnScope: { kind: 'turn', turnItemId } })
      }
    }
    return scope
  }
  const loadRow = async (row: Record<string, unknown>, providerSessionId: string) => {
    const attachment = row.attachment
    const source =
      attachment && typeof attachment === 'object' && 'source_uuid' in attachment
        ? attachment.source_uuid
        : undefined
    const uuids = [row.uuid, source].filter((uuid): uuid is string => typeof uuid === 'string')
    const prompts = await reads.claudeHistoryPrompts(sessionId, uuids)
    for (const { uuid, itemId } of prompts) {
      localPrompts.set(uuid, itemId)
    }
    const keys = [
      ...claudeTranscriptItemKeys(row, providerSessionId),
      ...prompts.map(({ itemId }) => itemId)
    ]
    const missing = keys.filter((key) => !loaded.has(key))
    if (missing.length) {
      const items = await reads.historyItems(missing, { includeOpeners: true })
      journal.adopt(items)
      for (const { key } of items) {
        loaded.add(key)
      }
    }
  }
  return { saved, localPrompt, scopeOf, promptScope, dependencies, load, loadRow }
}

export type ClaudeTranscriptItemReader = Awaited<
  ReturnType<typeof createClaudeTranscriptItemReader>
>

/** Source matches must be read before the synchronous transcript translator chooses its scope. */
export function claudeTranscriptItemKeys(
  row: Record<string, unknown>,
  providerSessionId: string
): string[] {
  const frame = claudeMessageWithoutSyntheticText({
    ...row,
    session_id: row.sessionId,
    parent_tool_use_id: null
  })
  if (!frame) {
    return []
  }
  const keys: string[] = []
  const envelope = readClaudeMessageEnvelope(frame)
  if (envelope?.role === 'assistant') {
    if (envelope.messageId && typeof row.apiBlockIndex === 'number') {
      keys.push(
        agentJournalItemKey({
          provider: 'claude',
          sessionId: envelope.sessionId,
          uuid: claudeSourceBlockId(envelope.messageId, row.apiBlockIndex)
        })
      )
    }
    keys.push(
      agentJournalItemKey(
        envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')
          ? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
          : claudeMessageIdentity(envelope)
      )
    )
  }
  if (envelope) {
    for (const tool of claudeToolUses(envelope)) {
      keys.push(agentJournalItemKey(claudeToolIdentity(envelope.sessionId, tool.id)))
    }
    for (const result of claudeToolResults(envelope)) {
      keys.push(agentJournalItemKey(claudeToolIdentity(envelope.sessionId, result.toolUseId)))
    }
  }
  const { decoded } = claudeTranscriptPrompt(row, envelope, providerSessionId)
  if (decoded) {
    const sourceUuid =
      row.type === 'attachment' ? claudeText(claudeRecord(row.attachment)?.source_uuid) : null
    keys.push(
      agentJournalItemKey({
        provider: 'claude',
        sessionId: providerSessionId,
        uuid: sourceUuid ?? decoded.id
      })
    )
  }
  return keys
}

/** A restored call cannot undo its saved result or discard its original call metadata. */
export function claudeRestoredItemBody(
  body: AgentJournalItemBody,
  existing: AgentJournalItemBody
): AgentJournalItemBody {
  if (body.kind === 'tool-call' && existing.kind === 'tool-call') {
    return body.state === 'running'
      ? existing
      : { ...existing, ...body, name: existing.name, input: existing.input }
  }
  if (body.kind === 'message' && body.role === 'reasoning' && existing.kind === 'message') {
    return { ...existing, ...body }
  }
  return body
}
