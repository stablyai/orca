import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentType } from '../../../shared/agent-status-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'
import { createClaudeTranscriptItemReader } from '../../claude/claude-transcript-item-reader'
import { matchAcpHistoryTurns, type AcpHistoryCandidate } from '../../acp/acp-history-turn-matching'
import { acpNamedTextKey } from '../../acp/acp-turn-messages'
import { GROK_ACP_DIALECT } from '../../acp/acp-dialects/grok-dialect'
import { OPENCODE_ACP_DIALECT } from '../../acp/acp-dialects/opencode-dialect'
import { createLegacyProviderTimelineIdentityScheme } from '../agent-session-timeline/provider-timeline-identity'
import { usableJournalHistoryOrigin } from '../agent-session-journal/journal-history-origin'

/** Use the ordinary native-history coverage rules before appending disk history at rest. */
export function switchTranscriptNativeCoverage(input: {
  agent: AgentType
  providerSessionId: string
  journal: AgentSessionJournal
  items: readonly JournalReplacementItem[]
  check: () => void
}): ReadonlySet<string> {
  const covered = new Set<string>()
  if (!['claude', 'grok', 'opencode', 'opencode2'].includes(input.agent)) {
    return covered
  }
  const snapshot = input.journal.snapshot()
  const segments: JournalReplacementItem[][] = []
  for (const item of input.items) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      segments.push([])
    }
    segments.at(-1)?.push(item)
  }
  if (input.agent === 'claude') {
    const reader = createClaudeTranscriptItemReader(input.journal, snapshot.sessionId)
    for (const segment of segments) {
      const user = segment[0]
      if (user.identity.provider !== 'claude') {
        continue
      }
      const key = agentJournalItemKey(user.identity)
      const native = reader.saved(key) ?? reader.localPrompt(user.identity.uuid)
      if (native && native.itemId !== key) {
        segment.forEach((item) => covered.add(agentJournalItemKey(item.identity)))
      }
    }
    return covered
  }
  const scope = {
    sessionId: snapshot.sessionId,
    providerSessionId: input.providerSessionId,
    agent: input.agent,
    identity: input.agent === 'grok' ? ('prompt-id' as const) : ('user-message-id' as const),
    dialect: input.agent === 'grok' ? GROK_ACP_DIALECT : OPENCODE_ACP_DIALECT
  }
  const scheme = createLegacyProviderTimelineIdentityScheme(scope)
  const recordId = (item: JournalReplacementItem) =>
    item.identity.provider === 'legacy' ? item.identity.recordId.replace(/^opencode:/, '') : ''
  const candidates: AcpHistoryCandidate[] = segments.flatMap((segment) => {
    const user = segment[0]
    if (user.body.kind !== 'message') {
      return []
    }
    const turn = recordId(user)
    if (!turn) {
      return []
    }
    return [
      {
        source: {
          turn,
          user: {
            blocks: user.body.blocks,
            boundary: { method: 'session/update', params: {} }
          },
          textOnly: user.body.blocks.every((block) => block.type === 'text'),
          observations: [],
          messageIds: segment.map(recordId),
          startedAt: user.observedAt ?? null
        },
        items: segment.map((item) => ({
          kind: 'item' as const,
          identity: scheme.item({
            namespace: scope.providerSessionId,
            key: {
              source: 'provider',
              value: acpNamedTextKey(
                recordId(item).replace(/:reasoning(?::\d+)?$/, ''),
                item.body.kind === 'message' && item.body.role === 'reasoning'
                  ? 'reasoning'
                  : 'assistant'
              )
            },
            family: 'item',
            thread: scope.providerSessionId
          }),
          body: item.body,
          turnScope: { kind: 'thread' as const }
        }))
      }
    ]
  })
  const origin = usableJournalHistoryOrigin(input.journal.historyOrigin())
  const handle = origin?.providerHandle
  const importedAt =
    origin &&
    handle?.kind === 'opaque' &&
    handle.agent === input.agent &&
    handle.value === input.providerSessionId
      ? origin.importedAt
      : null
  const requests = new Set(
    input.journal
      .submissions()
      .filter((send) => send.handedOverAt !== undefined || send.handoverRecorded !== true)
      .map((send) => `prompt:${send.clientMessageId}`)
  )
  const { kind } = matchAcpHistoryTurns(
    scope,
    {
      items: new Map(
        snapshot.items
          .filter(
            (item) =>
              importedAt !== null || input.journal.itemProvenance(item.itemId).ownerFence !== 0
          )
          .map((item) => [item.itemId, item])
      )
    },
    candidates,
    importedAt,
    requests,
    input.check
  )
  for (const segment of segments) {
    if (kind.get(recordId(segment[0])) === 'native') {
      segment.forEach((item) => covered.add(agentJournalItemKey(item.identity)))
    }
  }
  return covered
}
