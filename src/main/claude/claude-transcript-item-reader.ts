import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { HISTORY_CATCH_UP_MAX_OPERATIONS } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { claudePromptUuidForSubmission } from './structured/claude-structured-session-id'

/** Every saved item used by the projection is a conditional commit dependency, even if equal. */
export function createClaudeTranscriptItemReader(
  journal: StructuredAgentSessionTransitionJournal,
  sessionId: string
) {
  const dependencies = new Map<string, AgentJournalRenderItem>()
  let localPrompts: Map<string, string> | undefined
  const saved = (key: string) => {
    const held = dependencies.get(key)
    if (held) {
      return held
    }
    const item = journal.item(journal.canonicalItemId(key))
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
    if (!localPrompts) {
      const prompts = new Map<string, string>()
      journal.visitItems((itemId, _sequence, body) => {
        if (
          body.kind === 'message' &&
          body.role === 'user' &&
          parseAgentJournalItemKey(itemId)?.provider === 'orca'
        ) {
          prompts.set(claudePromptUuidForSubmission(sessionId, itemId), itemId)
        }
      })
      localPrompts = prompts
    }
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
    journal.visitItems((itemId, _sequence, body) => {
      if (
        body.kind === 'turn' &&
        body.userItemId &&
        journal.canonicalItemId(body.userItemId) === item.itemId
      ) {
        const turn = saved(itemId)
        if (turn) {
          scope = scopeOf({ ...item, turnScope: { kind: 'turn', turnItemId: itemId } })
        }
      }
    })
    return scope
  }
  return { saved, localPrompt, scopeOf, promptScope, dependencies }
}
