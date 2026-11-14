import { isDeepStrictEqual } from 'node:util'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalTurnScope } from '../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionItemAppendOptions } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import { HISTORY_CATCH_UP_MAX_OPERATIONS } from '../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import { claudeRestoredItemBody } from './transcripts/claude-transcript-item-reader'

/** Resolve translator proposals against the bounded saved rows before admitting the catch-up. */
export function createClaudeTranscriptRowProjection(input: {
  mutations: Map<string, ReturnType<typeof journalLifecycleItemMutation>>
  saved: (key: string) => AgentJournalRenderItem | null
  scopeOf: (item: AgentJournalRenderItem) => AgentJournalTurnScope
  check: () => void
}) {
  const { mutations, saved, scopeOf } = input
  return (
    identity: AgentJournalItemIdentity,
    projected: AgentJournalItemBody,
    options: StructuredAgentSessionItemAppendOptions,
    historicalScope: AgentJournalTurnScope | null,
    sourceObservedAt: number | undefined,
    workAt: number | undefined
  ) => {
    input.check()
    const key = agentJournalItemKey(identity)
    const existing = saved(key)
    // A turn this import opened is history too: it must also take its end, never stay running.
    if (projected.kind === 'turn' && (existing || (historicalScope && !mutations.has(key)))) {
      return { accepted: true } as const
    }
    let body = projected
    // Idle housekeeping may use the host clock; an unknown historical endpoint cannot.
    if (body.kind === 'turn' && body.state === 'completed' && workAt === undefined) {
      const { completedAt: _completedAt, durationMs: _durationMs, ...untimed } = body
      body = untimed
    }
    let turnScope =
      projected.kind === 'turn' || (projected.kind === 'message' && projected.role === 'user')
        ? options.turnScope
        : (historicalScope ?? options.turnScope)
    if (existing) {
      if (body.kind === 'message' && body.role === 'user') {
        return { accepted: true } as const
      }
      turnScope = scopeOf(existing)
      body = claudeRestoredItemBody(body, existing.body)
      if (isDeepStrictEqual(existing.body, body)) {
        return { accepted: true } as const
      }
    }
    const observedAt = mutations.has(key) ? mutations.get(key)?.observedAt : sourceObservedAt
    mutations.set(key, {
      ...journalLifecycleItemMutation({ ...options, turnScope, observedAt }, identity, body),
      ...(body.kind === 'message' && body.role === 'user' ? { echoOf: null } : {})
    })
    if (mutations.size > HISTORY_CATCH_UP_MAX_OPERATIONS) {
      throw new Error('too-large')
    }
    return { accepted: true } as const
  }
}
