// The translator's writers, built once. Split out so the translator reads as
// routing, and so one place shows that every writer is handed the same
// row attribution: the roster's producer, which knows each child thread, and the turn scope.

import { CodexJournalCompactions } from './codex-structured-journal-compactions'
import type { CodexJournalTranslatorDeps } from './codex-structured-journal-contracts'
import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import { CodexJournalItems } from './codex-structured-journal-items'
import { CodexJournalPrompts } from './codex-structured-journal-prompts'
import { createCodexOversizedNotificationSettler } from './codex-structured-journal-translation-frames'
import { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { CodexJournalTurnScopes } from './codex-journal-turn-scopes'
import { CodexSubagentRoster } from './codex-subagent-roster'
import type { CodexRowAttribution } from './codex-subagent-linkage'

export function createCodexJournalTranslatorWriters(deps: CodexJournalTranslatorDeps) {
  const activeTurns = new CodexJournalActiveTurns()
  const activeTurn = (threadId: string): string | null => activeTurns.current(threadId)
  const primaryThreadId = (): string | null => deps.primaryThreadId?.() ?? null
  const turnScopes = new CodexJournalTurnScopes({
    sessionId: deps.sessionId,
    primaryThreadId,
    activeTurn
  })
  const subagents = new CodexSubagentRoster({
    sink: deps.sink,
    primaryThreadId,
    activeTurn,
    turnScopeFor: (threadId, turnId) => turnScopes.scopeFor(threadId, turnId),
    ...(deps.subagentExecutions ? { executions: deps.subagentExecutions } : {})
  })
  const { linkageFor } = subagents.linkage
  const attributionFor: CodexRowAttribution = (threadId, turnId) => ({
    ...linkageFor(threadId, turnId),
    turnScope: turnScopes.scopeFor(threadId, turnId)
  })
  const producerDeps = { ...deps, attributionFor }
  const genericFrames = new CodexJournalGenericFrames(producerDeps, activeTurn)
  const items = new CodexJournalItems(producerDeps, activeTurn, (threadId, turnId) =>
    genericFrames.suppress(threadId, turnId)
  )
  return {
    activeTurns,
    turnScopes,
    subagents,
    attributionFor,
    genericFrames,
    items,
    compactions: new CodexJournalCompactions(deps.sink, activeTurn, attributionFor, (turnId) =>
      turnScopes.claimed(turnId)
    ),
    goals: new CodexJournalGoals(deps.sink, attributionFor),
    prompts: new CodexJournalPrompts(
      producerDeps,
      (threadId, itemId) => items.detailFor(threadId, itemId),
      activeTurn
    ),
    settleOversizedNotification: createCodexOversizedNotificationSettler(producerDeps, items)
  }
}
