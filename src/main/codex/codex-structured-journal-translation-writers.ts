// The translator's writers, built once. Split out so the translator reads as
// routing, and so one place shows that every writer is handed the same
// producer resolver: the roster's, which knows each child thread.

import { CodexJournalCompactions } from './codex-structured-journal-compactions'
import type { CodexJournalTranslatorDeps } from './codex-structured-journal-contracts'
import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import { CodexJournalGoals } from './codex-structured-journal-goals'
import { CodexJournalItems } from './codex-structured-journal-items'
import { CodexJournalPrompts } from './codex-structured-journal-prompts'
import { createCodexOversizedNotificationSettler } from './codex-structured-journal-translation-frames'
import { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { CodexSubagentRoster } from './codex-subagent-roster'

export function createCodexJournalTranslatorWriters(deps: CodexJournalTranslatorDeps) {
  const activeTurns = new CodexJournalActiveTurns()
  const activeTurn = (threadId: string): string | null => activeTurns.current(threadId)
  const subagents = new CodexSubagentRoster({
    sink: deps.sink,
    primaryThreadId: () => deps.primaryThreadId?.() ?? null,
    activeTurn,
    ...(deps.subagentExecutions ? { executions: deps.subagentExecutions } : {})
  })
  const { linkageFor } = subagents.linkage
  const producerDeps = { ...deps, linkageFor }
  const genericFrames = new CodexJournalGenericFrames(producerDeps, activeTurn)
  const items = new CodexJournalItems(producerDeps, activeTurn, (threadId, turnId) =>
    genericFrames.suppress(threadId, turnId)
  )
  return {
    activeTurns,
    subagents,
    linkageFor,
    genericFrames,
    items,
    compactions: new CodexJournalCompactions(deps.sink, activeTurn, linkageFor),
    goals: new CodexJournalGoals(deps.sink, linkageFor),
    prompts: new CodexJournalPrompts(
      producerDeps,
      (threadId, itemId) => items.detailFor(threadId, itemId),
      activeTurn
    ),
    settleOversizedNotification: createCodexOversizedNotificationSettler(producerDeps, items)
  }
}
